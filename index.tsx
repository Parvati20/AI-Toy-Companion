/**
 * Cleaned and hardened Preact + TypeScript app
 * - Improved error handling for quota / rate limits
 * - Exponential backoff retry (for transient errors)
 * - Safer parsing of generateContent response
 * - Fixes: FileReader typing, speechSynthesis voices, recognition cleanup,
 *   URL.revokeObjectURL, audio unlock pattern
 *
 * NOTE: keep your API key server-side if possible. If you must call from browser,
 * make sure it's protected appropriately (CORS, short-lived tokens, etc).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { render } from 'preact';
// FIX: Add Ref type import for casting ref objects to fix type errors.
import type { Ref } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { jsx } from 'preact/jsx-runtime';
import { GoogleGenAI, Modality } from '@google/genai';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// ---------- Configuration ----------
const SAFE_RETRY_COUNT = 2;
const RETRY_BASE_DELAY_MS = 800; // exponential backoff base

// instantiate SDK client (ensure API key set securely in your runtime)
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });

// Speech recognition compat
const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
const recognitionPrototype = SpeechRecognition ? new SpeechRecognition() : null;

// ---------- Helpers ----------
function base64Encode(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result;
      if (typeof result === 'string') {
        const afterComma = result.split(',')[1] || '';
        resolve(afterComma);
      } else {
        reject(new Error('File could not be read as a string.'));
      }
    };
    reader.onerror = () => reject(new Error('Could not read file.'));
    reader.readAsDataURL(file);
  });
}

function isQuotaError(err: any): boolean {
  if (!err) return false;
  const msg = String(err.message || err).toLowerCase();
  return msg.includes('quota') || msg.includes('limit') || msg.includes('exceeded') || msg.includes('rate limit') || msg.includes('429');
}

function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

// ---------- App ----------
function App() {
  // UI states
  const [toyImage, setToyImage] = useState<string | null>(null); // object URL for display
  const [toyImagePart, setToyImagePart] = useState<any | null>(null); // inlineData for SDK
  const [toyModel, setToyModel] = useState<File | null>(null);
  const [toyDescription, setToyDescription] = useState<string>('');
  const [userCommand, setUserCommand] = useState<string>('');
  const [toyReply, setToyReply] = useState<string>('');
  const [actionImage, setActionImage] = useState<string | null>(null);
  const [isLoadingDescription, setIsLoadingDescription] = useState(false);
  const [isLoadingResponse, setIsLoadingResponse] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [error, setError] = useState<string>('');
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [lastSendAt, setLastSendAt] = useState<number>(0);

  // refs
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const modelInputRef = useRef<HTMLInputElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const recognitionRef = useRef<any | null>(null);
  const toyImageObjectUrlRef = useRef<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // initialize recognition once (but don't reuse live instance across sessions)
  useEffect(() => {
    if (!SpeechRecognition) return;
    // We'll clone a fresh recognition instance on each start for safety
    recognitionRef.current = null;
    return () => {
      // cleanup if any
      if (recognitionRef.current) {
        try {
          recognitionRef.current.onresult = null;
          recognitionRef.current.onend = null;
          recognitionRef.current.onerror = null;
          recognitionRef.current.stop();
        } catch {}
        recognitionRef.current = null;
      }
    };
  }, []);

  // speak when toyReply changes
  useEffect(() => {
    if (toyReply) {
      playSound('reply');
      speakText(toyReply);
    }
  }, [toyReply]);

  useEffect(() => {
    if (actionImage) playSound('image');
  }, [actionImage]);

  // load voices
  useEffect(() => {
    if (!('speechSynthesis' in window)) return;
    const load = () => {
      const vs = window.speechSynthesis.getVoices() || [];
      setVoices(vs);
    };
    window.speechSynthesis.onvoiceschanged = load;
    load();
    return () => {
      if (window.speechSynthesis) window.speechSynthesis.onvoiceschanged = null;
    };
  }, []);

  // ---------- Audio helpers ----------
  const initializeAudio = () => {
    if (audioContextRef.current) {
      if (audioContextRef.current.state === 'suspended') {
        audioContextRef.current.resume().catch(() => {});
      }
      return;
    }
    try {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      audioContextRef.current = ctx;

      // unlock trick (silent buffer)
      const buffer = ctx.createBuffer(1, 1, 22050);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      src.start(0);
      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }
    } catch (err) {
      console.warn('Audio API not available', err);
    }
  };

  const playSound = (type: 'click' | 'reply' | 'image' | 'success' | 'error' | 'micOn' | 'micOff') => {
    const audioCtx = audioContextRef.current;
    if (!audioCtx) return;
    const now = audioCtx.currentTime;

    const createOsc = (freq: number) => {
      const o = audioCtx.createOscillator();
      o.frequency.setValueAtTime(freq, now);
      return o;
    };
    const createGain = (start: number, dur: number) => {
      const g = audioCtx.createGain();
      g.gain.setValueAtTime(start, now);
      g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
      return g;
    };

    switch (type) {
      case 'click': {
        const o = createOsc(800);
        const g = createGain(0.1, 0.1);
        o.type = 'triangle';
        o.connect(g).connect(audioCtx.destination);
        o.start(now);
        o.stop(now + 0.1);
        break;
      }
      case 'reply':
      case 'image':
      case 'success':
        // These sounds have been removed as they were perceived as irritating background music.
        return;

      case 'micOn': {
        const o = createOsc(440);
        const g = createGain(0.2, 0.2);
        o.frequency.exponentialRampToValueAtTime(660, now + 0.12);
        o.connect(g).connect(audioCtx.destination);
        o.start(now);
        o.stop(now + 0.16);
        break;
      }
      case 'micOff': {
        const o = createOsc(660);
        const g = createGain(0.2, 0.2);
        o.frequency.exponentialRampToValueAtTime(440, now + 0.12);
        o.connect(g).connect(audioCtx.destination);
        o.start(now);
        o.stop(now + 0.16);
        break;
      }
      case 'error': {
        const o = createOsc(150);
        o.type = 'sawtooth';
        const g = createGain(0.2, 0.4);
        o.connect(g).connect(audioCtx.destination);
        o.start(now);
        o.stop(now + 0.4);
        break;
      }
    }
  };

  const speakText = (text: string) => {
    if (!('speechSynthesis' in window)) return;
    if (!text) return;
    try {
      window.speechSynthesis.cancel();
    } catch {}
    const u = new SpeechSynthesisUtterance(text);
    // choose a voice
    const preferred = voices.find(v => /google us english/i.test(v.name)) || voices.find(v => v.lang.startsWith('en') && v.name.toLowerCase().includes('female')) || voices.find(v => v.lang.startsWith('en'));
    if (preferred) u.voice = preferred;
    u.pitch = 1.5;
    u.rate = 1.15;
    u.volume = 0.95;
    window.speechSynthesis.speak(u);
  };

  // ---------- Error helper ----------
  const handleError = (message: string) => {
    initializeAudio();
    playSound('error');
    setError(message);
    // auto-clear after 6s
    setTimeout(() => setError(''), 6000);
  };

  const startOver = () => {
    initializeAudio();
    playSound('click');
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    setToyImage(null);
    setToyImagePart(null);
    setToyModel(null);
    setToyDescription('');
    setUserCommand('');
    setToyReply('');
    setActionImage(null);
    setError('');
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (modelInputRef.current) modelInputRef.current.value = '';
    if (toyImageObjectUrlRef.current) {
      URL.revokeObjectURL(toyImageObjectUrlRef.current);
      toyImageObjectUrlRef.current = null;
    }
    // abort any ongoing request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  };

  // ---------- File handlers ----------
  const handleFileChange = async (evt: Event) => {
    const el = evt.target as HTMLInputElement;
    const file = el.files ? el.files[0] : null;
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      handleError('Please upload an image file.');
      return;
    }

    startOver();
    initializeAudio();
    playSound('click');

    // show quickly
    const objUrl = URL.createObjectURL(file);
    toyImageObjectUrlRef.current = objUrl;
    setToyImage(objUrl);
    setIsLoadingDescription(true);

    try {
      const b64 = await base64Encode(file);
      const imagePart = { inlineData: { data: b64, mimeType: file.type } };
      setToyImagePart(imagePart);

      // call the SDK with retry/backoff
      let attempt = 0;
      let lastErr: any = null;
      while (attempt <= SAFE_RETRY_COUNT) {
        try {
          // create abort controller for this request
          abortControllerRef.current = new AbortController();

          const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: { parts: [imagePart, { text: "Describe this toy in a few simple, friendly words for a child." }] },
            // if SDK supports passing signal, include it
            // @ts-ignore
            signal: abortControllerRef.current.signal,
          });
          // FIX: Use the recommended .text accessor for the response, which is safer and simpler.
          // parse safely
          const parsedText = response.text || '';

          if (parsedText) {
            setToyDescription(parsedText);
          } else {
            setToyDescription('A friendly toy! (Could not get a detailed description.)');
          }
          playSound('success');
          lastErr = null;
          break; // success
        } catch (err: any) {
          lastErr = err;
          if (isQuotaError(err)) {
            handleError("Looks like the daily request limit for the AI model has been reached. Please try again tomorrow.");
            break; // don't retry on quota exceeded
          }
          // for transient network errors, retry
          attempt += 1;
          if (attempt > SAFE_RETRY_COUNT) {
            console.error('Final error describing toy:', err);
            handleError('Could not describe the toy. Please try again.');
            break;
          }
          const backoff = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
          await sleep(backoff);
        } finally {
          abortControllerRef.current = null;
        }
      }
    } catch (err) {
      console.error(err);
      handleError('Failed to read the image or call the API.');
      // cleanup image preview if needed
      if (toyImageObjectUrlRef.current) {
        URL.revokeObjectURL(toyImageObjectUrlRef.current);
        toyImageObjectUrlRef.current = null;
      }
      setToyImage(null);
    } finally {
      setIsLoadingDescription(false);
    }
  };

  const handleModelChange = (evt: Event) => {
    const el = evt.target as HTMLInputElement;
    const file = el.files ? el.files[0] : null;
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.glb')) {
      handleError('Please upload a .glb model file.');
      return;
    }
    setToyModel(file);
  };

  // ---------- Sending commands ----------
  // debounce/guard to avoid accidental duplicates
  const canSendNow = () => {
    const now = Date.now();
    if (now - lastSendAt < 600) return false;
    setLastSendAt(now);
    return true;
  };

  const sendCommand = async (commandText?: string) => {
    const cmd = (commandText ?? userCommand ?? '').trim();
    if (!cmd || !toyImagePart) return;
    if (!canSendNow()) return;

    initializeAudio();
    playSound('click');
    setIsLoadingResponse(true);
    setToyReply('');
    setActionImage(null);
    setError('');

    // build prompt
    const combinedPrompt = `You are an AI Toy Companion. The user's command is: "${cmd}".
Based on the user's command and the provided image of the toy, do two things:
1) Generate a short, playful, child-like text reply from the toy's perspective.
2) If appropriate and safe, generate a new cartoon-style image of the toy performing the action described.
If the command is unsafe or impossible for a toy, politely decline in text and do not generate an image.`;

    // retry loop for transient errors (but not for quota)
    let attempt = 0;
    let lastErr: any = null;

    while (attempt <= SAFE_RETRY_COUNT) {
      try {
        abortControllerRef.current = new AbortController();
        const response = await ai.models.generateContent({
          model: 'gemini-2.5-flash-image-preview',
          contents: { parts: [toyImagePart, { text: combinedPrompt }] },
          config: {
            responseModalities: [Modality.IMAGE, Modality.TEXT],
          },
          // @ts-ignore
          signal: abortControllerRef.current.signal,
        });

        // FIX: Robustly parse the multimodal response, using the recommended .text accessor for text
        // and iterating through parts for image data, avoiding deprecated/incorrect properties.
        // robust parsing:
        let foundText = '';
        let foundImageData = '';

        if (response) {
          foundText = response.text?.trim() ?? '';
          const parts = response.candidates?.[0]?.content?.parts || [];
          for (const part of parts) {
            if (part.inlineData?.data) {
              foundImageData = part.inlineData.data;
              break; // Assume one image part is sufficient
            }
          }
        }

        if (foundText) setToyReply(foundText);
        if (foundImageData) setActionImage(`data:image/png;base64,${foundImageData}`);

        if (!foundText && !foundImageData) {
          handleError("I couldn't produce a reply or image. Try a simpler command like 'dance' or 'say hi'.");
        }
        lastErr = null;
        break;
      } catch (err: any) {
        lastErr = err;
        if (isQuotaError(err)) {
          handleError("Looks like the daily request limit for the AI model has been reached. Please try again tomorrow.");
          break;
        }
        attempt += 1;
        if (attempt > SAFE_RETRY_COUNT) {
          console.error('Final error from sendCommand:', err);
          handleError('Something went wrong while generating the reply. Please try again.');
          break;
        }
        const backoff = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        await sleep(backoff);
      } finally {
        abortControllerRef.current = null;
      }
    }

    setIsLoadingResponse(false);
  };

  // ---------- Microphone handling ----------
  const handleMicClick = () => {
    initializeAudio();
    if (!SpeechRecognition) {
      handleError('Voice recognition is not supported in your browser.');
      return;
    }

    // if listening, stop and cleanup
    if (isListening) {
      try {
        recognitionRef.current?.stop();
      } catch {}
      playSound('micOff');
      setIsListening(false);
      return;
    }

    playSound('micOn');
    // create fresh recognition instance for robustness
    const recog = new (SpeechRecognition as any)();
    recog.lang = 'en-US';
    recog.interimResults = false;
    recog.maxAlternatives = 1;

    recog.onstart = () => setIsListening(true);
    recog.onend = () => setIsListening(false);
    recog.onerror = (event: any) => {
      setIsListening(false);
      handleError(`Voice recognition error: ${event?.error || 'unknown'}`);
    };
    recog.onresult = (event: any) => {
      try {
        const transcript = event.results[0][0].transcript;
        setUserCommand(transcript);
        sendCommand(transcript);
      } catch (err) {
        console.warn('Error reading recognition result', err);
      }
    };

    recognitionRef.current = recog;
    try {
      recog.start();
    } catch (err) {
      handleError('Could not start voice recognition.');
    }
  };

  const commands = ['say hi', 'dance', 'jump', 'be happy', 'be angry', 'tell a story'];

  // ---------- Render ----------
  return jsx('div', {
    className: 'container',
    children: [
      jsx('header', {
        children: [
          jsx('h1', { children: 'AI Toy Companion' }),
          !toyImage && jsx('p', { children: 'Upload a picture of your toy and bring it to life!' }),
          toyImage &&
            jsx('button', {
              className: 'header-start-over-btn',
              onClick: startOver,
              children: 'Start Over',
            }),
        ],
      }),
      jsx('main', {
        children:
          !toyImage
            ? jsx('div', {
                className: 'upload-container',
                children: [
                  jsx(UploadIcon, {}),
                  jsx('h2', { children: "Let's meet your toy!" }),
                  jsx('p', { children: 'Upload a photo to get started.' }),
                  jsx('input', {
                    type: 'file',
                    accept: 'image/*',
                    onChange: handleFileChange,
                    // FIX: Cast ref to any to resolve TypeScript error due to incorrect type inference for JSX function.
                    ref: fileInputRef as any,
                    id: 'file-upload',
                    'aria-label': 'Upload toy photo',
                  }),
                  jsx('button', {
                    onClick: () => {
                      initializeAudio();
                      playSound('click');
                      fileInputRef.current?.click();
                    },
                    children: 'Upload Your Toy!',
                  }),
                  jsx('input', {
                    type: 'file',
                    accept: '.glb',
                    onChange: handleModelChange,
                    // FIX: Cast ref to any to resolve TypeScript error.
                    ref: modelInputRef as any,
                    id: 'model-upload',
                    style: { display: 'none' },
                  }),
                  jsx('button', {
                    className: 'secondary-btn',
                    onClick: () => {
                      initializeAudio();
                      playSound('click');
                      modelInputRef.current?.click();
                    },
                    children: 'Optional: Upload 3D Model (.glb)',
                  }),
                ],
              })
            : jsx('div', {
                className: 'companion-container',
                children: [
                  jsx('div', {
                    className: 'toy-panel',
                    children: [
                      jsx('img', { src: toyImage, alt: "User's toy", className: 'toy-image' }),
                      isLoadingDescription && jsx(LoadingSpinner, { text: 'Getting to know your toy...' }),
                      toyDescription && jsx('p', { className: 'toy-description', children: toyDescription }),
                      jsx('button', { className: 'change-toy-btn', onClick: startOver, children: 'Start Over' }),
                    ],
                  }),
                  jsx('div', {
                    className: 'interaction-panel',
                    children: [
                      jsx('div', {
                        className: 'response-area',
                        children: [
                          !isLoadingResponse && !toyReply && !actionImage && jsx('div', { className: 'welcome-message', children: "What should we do next? Try 'catch a ball' or 'tell a story'!" }),
                          isLoadingResponse && !toyReply && jsx(LoadingSpinner, { text: 'Thinking...' }),
                          toyReply && jsx('div', { className: 'speech-bubble', children: toyReply }),
                          isLoadingResponse && toyReply && jsx(LoadingSpinner, { text: 'Drawing a picture...' }),
                          (actionImage || toyModel) && jsx('div', {
                            className: 'media-display-area',
                            children: [
                              actionImage && jsx('img', { src: actionImage, alt: 'Generated action by toy', className: 'action-image' }),
                              toyModel && jsx(ThreeDViewer, { modelFile: toyModel }),
                            ],
                          }),
                        ],
                      }),
                      jsx('div', {
                        className: 'command-bar',
                        children: [
                          jsx('div', {
                            className: 'preset-commands',
                            children: commands.map((cmd) =>
                              jsx('button', {
                                onClick: () => {
                                  initializeAudio();
                                  playSound('click');
                                  setUserCommand(cmd);
                                  sendCommand(cmd);
                                },
                                children: cmd.charAt(0).toUpperCase() + cmd.slice(1),
                              })
                            ),
                          }),
                          jsx('form', {
                            className: 'text-command',
                            onSubmit: (e: Event) => {
                              e.preventDefault();
                              initializeAudio();
                              playSound('click');
                              sendCommand(userCommand);
                            },
                            children: [
                              jsx('input', {
                                type: 'text',
                                value: userCommand,
                                onInput: (e: any) => setUserCommand(e.target.value),
                                placeholder: 'Type a command or use the mic...',
                                'aria-label': 'Type a command',
                              }),
                              SpeechRecognition && jsx('button', {
                                type: 'button',
                                onClick: handleMicClick,
                                className: `mic-button ${isListening ? 'listening' : ''}`,
                                'aria-label': 'Use voice command',
                                children: jsx(MicIcon, {}),
                              }),
                              jsx('button', { type: 'submit', 'aria-label': 'Send command', children: jsx(SendIcon, {}) }),
                            ],
                          }),
                        ],
                      }),
                    ],
                  }),
                ],
              }),
      }),
      error && jsx('div', { className: 'error-popup', role: 'alert', children: error }),
    ],
  });
}

// ---------- 3D Viewer component ----------
function ThreeDViewer({ modelFile }: { modelFile: File | null }) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const objectUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (!modelFile || !mountRef.current) return;
    setIsLoading(true);

    const scene = new THREE.Scene();
    const mount = mountRef.current;
    const camera = new THREE.PerspectiveCamera(75, mount.clientWidth / mount.clientHeight, 0.1, 1000);
    camera.position.z = 5;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setClearColor(0x000000, 0);
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    mount.appendChild(renderer.domElement);

    const ambientLight = new THREE.AmbientLight(0xffffff, 1.5);
    scene.add(ambientLight);
    const directionalLight = new THREE.DirectionalLight(0xffffff, 2);
    directionalLight.position.set(5, 10, 7.5);
    scene.add(directionalLight);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;

    const loader = new GLTFLoader();
    const modelUrl = URL.createObjectURL(modelFile);
    objectUrlRef.current = modelUrl;

    loader.load(
      modelUrl,
      (gltf) => {
        const model = gltf.scene;
        const box = new THREE.Box3().setFromObject(model);
        const center = box.getCenter(new THREE.Vector3());
        model.position.sub(center);
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);
        const scale = maxDim > 0 ? 5 / maxDim : 1;
        model.scale.set(scale, scale, scale);
        scene.add(model);
        setIsLoading(false);
      },
      undefined,
      (err) => {
        console.error('Error loading GLB', err);
        setIsLoading(false);
      }
    );

    let afId: number;
    const animate = () => {
      afId = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    const handleResize = () => {
      if (!mountRef.current) return;
      camera.aspect = mountRef.current.clientWidth / mountRef.current.clientHeight;
      camera.updateProjectionMatrix();
      // FIX: renderer.setSize requires width and height as separate arguments.
      renderer.setSize(mountRef.current.clientWidth, mountRef.current.clientHeight);
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      cancelAnimationFrame(afId);
      try {
        URL.revokeObjectURL(modelUrl);
      } catch {}
      if (mount && renderer.domElement) mount.removeChild(renderer.domElement);
      renderer.dispose();
      scene.traverse((obj) => {
        // dispose geometry and materials
        if ((obj as any).geometry) {
          try {
            (obj as any).geometry.dispose();
          } catch {}
        }
        if ((obj as any).material) {
          const m = (obj as any).material;
          if (Array.isArray(m)) {
            m.forEach((mat) => mat.dispose && mat.dispose());
          } else {
            m.dispose && m.dispose();
          }
        }
      });
    };
  }, [modelFile]);

  return jsx('div', {
    className: 'threed-viewer-container',
    children: [
      isLoading && jsx(LoadingSpinner, { text: 'Loading 3D model...' }),
      // FIX: Cast ref to any to resolve TypeScript error.
      jsx('div', { ref: mountRef as any, className: 'threed-canvas' }),
    ],
  });
}

// ---------- Small UI bits ----------
const LoadingSpinner = ({ text }: { text: string }) =>
  jsx('div', { className: 'loading-spinner', 'aria-label': text, role: 'status', children: [jsx('div', { className: 'spinner' }), jsx('p', { children: text })] });

const MicIcon = () =>
  jsx('svg', { xmlns: 'http://www.w3.org/2000/svg', viewBox: '0 0 24 24', fill: 'currentColor', children: jsx('path', { d: 'M12 14q-1.25 0-2.125-.875T9 11V5q0-1.25.875-2.125T12 2q1.25 0 2.125.875T15 5v6q0 1.25-.875 2.125T12 14Zm-1 7v-3.075q-2.6-.35-4.3-2.325T4 11H6q0 2.075 1.463 3.537T11 16v-1q-2.075 0-3.537-1.463T6 11V5q0-2.5 1.75-4.25T12 0q2.5 0 4.25 1.75T18 5v6q0 2.075-1.463 3.537T13 16v1q2.075 0 3.538-1.463T18 11h2q0 2.525-1.7 4.5T14 17.925V21h-3Z' }) });

const SendIcon = () => jsx('svg', { xmlns: 'http://www.w3.org/2000/svg', viewBox: '0 0 24 24', fill: 'currentColor', children: jsx('path', { d: 'M3 20v-6l8-2-8-2V4l19 8-19 8Z' }) });

const UploadIcon = () =>
  jsx('svg', { className: 'upload-icon', xmlns: 'http://www.w3.org/2000/svg', viewBox: '0 0 24 24', fill: 'currentColor', children: jsx('path', { d: 'M11 16V7.85l-2.6 2.6L7 9l5-5 5 5-1.4 1.45-2.6-2.6V16h-2Zm-5 4q-.825 0-1.413-.588T4 18v-3h2v3h12v-3h2v3q0 .825-.588 1.413T18 20H6Z' }) });

// mount to DOM
render(jsx(App, {}), document.getElementById('app'));