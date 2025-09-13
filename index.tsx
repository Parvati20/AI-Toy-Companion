/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import { render } from 'preact';
import { useState, useRef, useEffect } from 'preact/hooks';
import { jsx } from 'preact/jsx-runtime';
import { GoogleGenAI, Type, Modality } from '@google/genai';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';


// --- Helper Functions ---
function base64Encode(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
        if (typeof reader.result === 'string') {
            resolve(reader.result.split(',')[1]);
        } else {
            reject(new Error('File could not be read as a string.'));
        }
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
const recognition = SpeechRecognition ? new SpeechRecognition() : null;

// --- App Component ---
function App() {
  const [toyImage, setToyImage] = useState(null); // Data URL for display
  const [toyImagePart, setToyImagePart] = useState(null); // Gemini API part
  const [toyModel, setToyModel] = useState(null); // 3D model file
  const [toyDescription, setToyDescription] = useState('');
  const [userCommand, setUserCommand] = useState('');
  const [toyReply, setToyReply] = useState('');
  const [actionImage, setActionImage] = useState('');
  const [isLoadingDescription, setIsLoadingDescription] = useState(false);
  const [isLoadingResponse, setIsLoadingResponse] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [error, setError] = useState('');
  const fileInputRef = useRef(null);
  const modelInputRef = useRef(null);
  const audioContextRef = useRef(null);
  const musicOscillatorRef = useRef(null);
  const musicGainRef = useRef(null);
  const musicLoopTimerRef = useRef(null);

  const initializeAudio = () => {
    if (!audioContextRef.current) {
        try {
            audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
        } catch (e) {
            console.error("Web Audio API is not supported in this browser.");
        }
    }
    // Resume audio context if it was suspended by the browser's autoplay policy
    if (audioContextRef.current?.state === 'suspended') {
      audioContextRef.current.resume();
    }
  };
  
  const playSound = (type: 'click' | 'reply' | 'image' | 'success' | 'error' | 'micOn' | 'micOff') => {
      if (!audioContextRef.current) return;
      const audioCtx = audioContextRef.current;
      const now = audioCtx.currentTime;

      const createOscillator = (freq: number) => {
          const oscillator = audioCtx.createOscillator();
          oscillator.frequency.setValueAtTime(freq, now);
          return oscillator;
      };

      const createGain = (startVolume: number, duration: number) => {
          const gainNode = audioCtx.createGain();
          gainNode.gain.setValueAtTime(startVolume, now);
          gainNode.gain.exponentialRampToValueAtTime(0.0001, now + duration);
          return gainNode;
      };
      
      switch (type) {
          case 'click': {
              const oscillator = createOscillator(800);
              const gainNode = createGain(0.1, 0.1);
              oscillator.type = 'triangle';
              oscillator.connect(gainNode).connect(audioCtx.destination);
              oscillator.start(now);
              oscillator.stop(now + 0.1);
              break;
          }
          case 'success': {
              const oscillator1 = createOscillator(523.25); // C5
              const oscillator2 = createOscillator(659.25); // E5
              const gainNode = createGain(0.2, 0.4);
              [oscillator1, oscillator2].forEach(osc => {
                  osc.connect(gainNode).connect(audioCtx.destination);
                  osc.start(now);
                  osc.stop(now + 0.3);
              });
              break;
          }
          case 'reply': {
              const notes = [659.25, 783.99, 987.77]; // E5, G5, B5
              const gainNode = audioCtx.createGain();
              gainNode.gain.setValueAtTime(0.2, now);
              gainNode.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);
              gainNode.connect(audioCtx.destination);

              notes.forEach((note, i) => {
                  const osc = createOscillator(note);
                  osc.type = 'sine';
                  osc.connect(gainNode);
                  osc.start(now + i * 0.08);
                  osc.stop(now + i * 0.08 + 0.1);
              });
              break;
          }
          case 'image': {
              const oscillator = createOscillator(400);
              const gainNode = createGain(0.3, 0.5);
              oscillator.frequency.exponentialRampToValueAtTime(1200, now + 0.5);
              oscillator.connect(gainNode).connect(audioCtx.destination);
              oscillator.start(now);
              oscillator.stop(now + 0.5);
              break;
          }
          case 'micOn': {
              const oscillator = createOscillator(440);
              const gainNode = createGain(0.2, 0.2);
              oscillator.frequency.exponentialRampToValueAtTime(660, now + 0.15);
              oscillator.connect(gainNode).connect(audioCtx.destination);
              oscillator.start(now);
              oscillator.stop(now + 0.2);
              break;
          }
          case 'micOff': {
              const oscillator = createOscillator(660);
              const gainNode = createGain(0.2, 0.2);
              oscillator.frequency.exponentialRampToValueAtTime(440, now + 0.15);
              oscillator.connect(gainNode).connect(audioCtx.destination);
              oscillator.start(now);
              oscillator.stop(now + 0.2);
              break;
          }
          case 'error': {
              const oscillator = createOscillator(150);
              const gainNode = createGain(0.2, 0.5);
              oscillator.type = 'sawtooth';
              oscillator.connect(gainNode).connect(audioCtx.destination);
              oscillator.start(now);
              oscillator.stop(now + 0.4);
              break;
          }
      }
  };

  const stopBackgroundMusic = () => {
    if (musicLoopTimerRef.current) {
        clearTimeout(musicLoopTimerRef.current);
        musicLoopTimerRef.current = null;
    }
    if (musicGainRef.current && audioContextRef.current) {
        const audioCtx = audioContextRef.current;
        const now = audioCtx.currentTime;
        // Fade out
        musicGainRef.current.gain.cancelScheduledValues(now);
        musicGainRef.current.gain.setValueAtTime(musicGainRef.current.gain.value, now);
        musicGainRef.current.gain.linearRampToValueAtTime(0, now + 0.5);

        // Stop the oscillator after the fade-out is complete
        if (musicOscillatorRef.current) {
            try {
                musicOscillatorRef.current.stop(now + 0.5);
            } catch (e) {
                // Ignore errors from stopping an already stopped oscillator
            }
            musicOscillatorRef.current = null;
        }
        musicGainRef.current = null;
    }
  };
  
  const playBackgroundMusic = () => {
    if (!audioContextRef.current || musicLoopTimerRef.current) return;
    stopBackgroundMusic(); // Clear any residue

    const audioCtx = audioContextRef.current;
    const now = audioCtx.currentTime;

    const melody = [
        { freq: 523.25, duration: 250 }, // C5
        { freq: 587.33, duration: 250 }, // D5
        { freq: 659.25, duration: 500 }, // E5
        { freq: 0, duration: 2000 },     // Rest for 2 seconds
    ];

    const oscillator = audioCtx.createOscillator();
    oscillator.type = 'triangle';
    musicOscillatorRef.current = oscillator;

    const gainNode = audioCtx.createGain();
    musicGainRef.current = gainNode;

    gainNode.connect(audioCtx.destination);
    oscillator.connect(gainNode);
    
    // Set initial gain to 0 and fade in
    gainNode.gain.setValueAtTime(0, now);
    gainNode.gain.linearRampToValueAtTime(0.04, now + 1.0); // Low volume, fade in

    let noteIndex = 0;
    const scheduleNote = () => {
        if (!audioContextRef.current) return; // Stop if context is gone
        const note = melody[noteIndex];
        const noteTime = audioContextRef.current.currentTime;
        
        if (note.freq > 0) {
            musicOscillatorRef.current.frequency.setValueAtTime(note.freq, noteTime);
            musicGainRef.current.gain.setTargetAtTime(0.04, noteTime, 0.01);
        } else {
            musicGainRef.current.gain.setTargetAtTime(0, noteTime, 0.01);
        }

        noteIndex = (noteIndex + 1) % melody.length;
        musicLoopTimerRef.current = setTimeout(scheduleNote, note.duration);
    };

    oscillator.start();
    scheduleNote();
  };

  const handleError = (message) => {
    playSound('error');
    setError(message);
    setTimeout(() => setError(''), 5000);
  };
  
  const startOver = () => {
    initializeAudio();
    playSound('click');
    stopBackgroundMusic();
    setToyImage(null);
    setToyImagePart(null);
    setToyModel(null);
    setToyDescription('');
    setUserCommand('');
    setToyReply('');
    setActionImage('');
    setError('');
    if (fileInputRef.current) {
        fileInputRef.current.value = null;
    }
    if (modelInputRef.current) {
        modelInputRef.current.value = null;
    }
  }

  const handleFileChange = async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
        handleError('Please upload an image file.');
        return;
    }

    startOver(); // Reset everything before starting
    setToyImage(URL.createObjectURL(file));
    setIsLoadingDescription(true);

    try {
      const base64Data = await base64Encode(file);
      const imagePart = {
        inlineData: { data: base64Data, mimeType: file.type },
      };
      setToyImagePart(imagePart);
      
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: { parts: [imagePart, { text: "Describe this toy in a few simple, friendly words for a child." }] },
      });
      setToyDescription(response.text);
      playSound('success');
      playBackgroundMusic();

    } catch (err) {
      console.error(err);
      if (err.toString().toLowerCase().includes('quota')) {
        handleError("You've reached the daily limit for requests. Please try again tomorrow!");
      } else {
        handleError('Could not describe the toy. Please try again.');
      }
      setToyImage(null);
    } finally {
      setIsLoadingDescription(false);
    }
  };
  
  const handleModelChange = (event) => {
    const file = event.target.files[0];
    if (!file) return;
    if (!file.name.endsWith('.glb')) {
        handleError('Please upload a .glb model file.');
        return;
    }
    setToyModel(file);
  };


  const sendCommand = async (commandText) => {
    if (!commandText || !toyImagePart) return;

    setIsLoadingResponse(true);
    setToyReply('');
    setActionImage('');
    setError('');

    try {
        const combinedPrompt = `You are an AI Toy Companion. The user's command is: "${commandText}".
        Based on the user's command and the provided image of the toy, do two things:
        1.  Generate a short, playful, child-like text reply from the toy's perspective.
        2.  Generate a new cartoon-style image of the toy performing the action described in the command.

        If the command is too complex, unsafe, or nonsensical for a toy, politely decline in your text reply and do not generate a new image. For example, if the user says "drive a car", you could reply "Vroom vroom! I'm too little to drive a real car, but I can pretend!". In this case, only a text response is needed.
        For a simple command like "dance", your text reply could be "Whee! I love to dance!" and you should generate an image of the toy dancing.`;
        
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash-image-preview',
            contents: {
                parts: [
                    toyImagePart,
                    { text: combinedPrompt }
                ],
            },
            config: {
                responseModalities: [Modality.IMAGE, Modality.TEXT],
            },
        });
        
        let foundText = '';
        let foundImage = '';

        // The model can output both text and image parts.
        for (const part of response.candidates[0].content.parts) {
            if (part.text) {
                foundText = part.text;
            } else if (part.inlineData) {
                const base64ImageBytes = part.inlineData.data;
                foundImage = `data:image/png;base64,${base64ImageBytes}`;
            }
        }

        if (foundText) {
            setToyReply(foundText);
            playSound('reply');
        }

        if (foundImage) {
            setActionImage(foundImage);
            playSound('image');
        }

        if (!foundText && !foundImage) {
            handleError("I'm not sure what to do! Please try another command.");
        }

    } catch (err) {
        console.error(err);
        if (err.toString().toLowerCase().includes('quota')) {
            handleError("You've reached the daily limit for generating replies. Please try again tomorrow!");
        } else {
            handleError('Something went wrong. Please try another command.');
        }
    } finally {
        setIsLoadingResponse(false);
    }
  };

  const handleMicClick = () => {
    initializeAudio();
    if (!recognition) {
        handleError('Voice recognition is not supported in your browser.');
        return;
    }
    if (isListening) {
        recognition.stop();
        playSound('micOff');
        setIsListening(false);
        return;
    }
    
    playSound('micOn');
    recognition.start();
    recognition.onstart = () => setIsListening(true);
    recognition.onend = () => setIsListening(false);
    recognition.onerror = (event) => handleError(`Voice recognition error: ${event.error}`);
    recognition.onresult = (event) => {
        const transcript = event.results[0][0].transcript;
        setUserCommand(transcript);
        sendCommand(transcript);
    };
  };
  
  const commands = ["say hi", "dance", "jump", "be happy", "be angry", "tell a story"];

  return jsx('div', {
    className: 'container',
    children: [
      jsx('header', {
        children: [
          jsx('h1', { children: 'AI Toy Companion' }),
          !toyImage && jsx('p', { children: 'Upload a picture of your toy and bring it to life!' }),
          toyImage && jsx('button', {
              className: 'header-start-over-btn',
              onClick: startOver,
              children: 'Start Over'
          })
        ],
      }),
      jsx('main', {
        children: !toyImage
          ? jsx('div', {
              className: 'upload-container',
              children: [
                jsx(UploadIcon, {}),
                jsx('h2', { children: "Let's meet your toy!"}),
                jsx('p', { children: "Upload a photo to get started."}),
                jsx('input', {
                  type: 'file',
                  accept: 'image/*',
                  onChange: handleFileChange,
                  ref: fileInputRef,
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
                  ref: modelInputRef,
                  id: 'model-upload',
                  style: { display: 'none' }
                }),
                jsx('button', {
                  className: 'secondary-btn',
                  onClick: () => {
                    initializeAudio();
                    playSound('click');
                    modelInputRef.current?.click()
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
                    jsx('img', { src: toyImage, alt: 'User\'s toy', className: 'toy-image' }),
                    isLoadingDescription && jsx(LoadingSpinner, { text: 'Getting to know your toy...' }),
                    toyDescription && jsx('p', { className: 'toy-description', children: toyDescription }),
                     jsx('button', {
                        className: 'change-toy-btn',
                        onClick: startOver,
                        children: 'Start Over'
                    })
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
                        toyReply && jsx('div', {
                          className: 'speech-bubble',
                          children: toyReply,
                        }),
                        isLoadingResponse && toyReply && jsx(LoadingSpinner, { text: 'Drawing a picture...' }),
                        (actionImage || toyModel) && jsx('div', {
                          className: 'media-display-area',
                          children: [
                              actionImage && jsx('img', { src: actionImage, alt: 'Generated action by toy', className: 'action-image' }),
                              toyModel && jsx(ThreeDViewer, { modelFile: toyModel })
                          ]
                        })
                      ],
                    }),
                    jsx('div', {
                      className: 'command-bar',
                      children: [
                         jsx('div', {
                            className: 'preset-commands',
                            children: commands.map(cmd => jsx('button', {
                                onClick: () => {
                                    initializeAudio();
                                    playSound('click');
                                    setUserCommand(cmd);
                                    sendCommand(cmd);
                                },
                                children: cmd.charAt(0).toUpperCase() + cmd.slice(1),
                            }))
                        }),
                        jsx('form', {
                          className: 'text-command',
                          onSubmit: (e) => {
                            e.preventDefault();
                            initializeAudio();
                            playSound('click');
                            sendCommand(userCommand);
                          },
                          children: [
                            jsx('input', {
                              type: 'text',
                              value: userCommand,
                              onInput: (e) => setUserCommand(e.target.value),
                              placeholder: 'Type a command or use the mic...',
                              'aria-label': 'Type a command',
                            }),
                            recognition && jsx('button', {
                                type: 'button',
                                onClick: handleMicClick,
                                className: `mic-button ${isListening ? 'listening' : ''}`,
                                'aria-label': 'Use voice command',
                                children: jsx(MicIcon, {})
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
      error && jsx('div', { className: 'error-popup', role: 'alert', children: error })
    ],
  });
}

function ThreeDViewer({ modelFile }) {
  const mountRef = useRef(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!modelFile || !mountRef.current) return;

    setIsLoading(true);
    const scene = new THREE.Scene();
    const mount = mountRef.current;
    
    const camera = new THREE.PerspectiveCamera(75, mount.clientWidth / mount.clientHeight, 0.1, 1000);
    camera.position.z = 5;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setClearColor(0x000000, 0); // Transparent background
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

    loader.load(modelUrl, (gltf) => {
      const model = gltf.scene;
      const box = new THREE.Box3().setFromObject(model);
      const center = box.getCenter(new THREE.Vector3());
      model.position.sub(center);
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z);
      const scale = 5 / maxDim;
      model.scale.set(scale, scale, scale);
      scene.add(model);
      setIsLoading(false);
    }, undefined, (error) => {
      console.error('An error happened while loading the model.', error);
      setIsLoading(false);
    });

    let animationFrameId;
    const animate = () => {
      animationFrameId = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    const handleResize = () => {
        if (mountRef.current) {
            camera.aspect = mountRef.current.clientWidth / mountRef.current.clientHeight;
            camera.updateProjectionMatrix();
            renderer.setSize(mountRef.current.clientWidth, mountRef.current.clientHeight);
        }
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      cancelAnimationFrame(animationFrameId);
      URL.revokeObjectURL(modelUrl);
      if (mountRef.current && renderer.domElement) {
        mountRef.current.removeChild(renderer.domElement);
      }
      renderer.dispose();
      scene.traverse(object => {
          if (object instanceof THREE.Mesh) {
              if(object.geometry) object.geometry.dispose();
              if(object.material) {
                  if (Array.isArray(object.material)) {
                      object.material.forEach(material => material.dispose());
                  } else {
                      object.material.dispose();
                  }
              }
          }
      });
    };
  }, [modelFile]);

  return jsx('div', {
    className: 'threed-viewer-container',
    children: [
        isLoading && jsx(LoadingSpinner, { text: 'Loading 3D model...' }),
        jsx('div', { ref: mountRef, className: 'threed-canvas' })
    ]
  });
}


const LoadingSpinner = ({ text }) => jsx('div', {
    className: 'loading-spinner',
    'aria-label': text,
    role: 'status',
    children: [
        jsx('div', { className: 'spinner' }),
        jsx('p', { children: text })
    ]
});

const MicIcon = () => jsx('svg', { xmlns: "http://www.w3.org/2000/svg", viewBox: "0 0 24 24", fill: "currentColor", children: jsx('path', { d: "M12 14q-1.25 0-2.125-.875T9 11V5q0-1.25.875-2.125T12 2q1.25 0 2.125.875T15 5v6q0 1.25-.875 2.125T12 14Zm-1 7v-3.075q-2.6-.35-4.3-2.325T4 11H6q0 2.075 1.463 3.537T11 16v-1q-2.075 0-3.537-1.463T6 11V5q0-2.5 1.75-4.25T12 0q2.5 0 4.25 1.75T18 5v6q0 2.075-1.463 3.537T13 16v1q2.075 0 3.538-1.463T18 11h2q0 2.525-1.7 4.5T14 17.925V21h-3Z"}) });
const SendIcon = () => jsx('svg', { xmlns: "http://www.w3.org/2000/svg", viewBox: "0 0 24 24", fill: "currentColor", children: jsx('path', { d: "M3 20v-6l8-2-8-2V4l19 8-19 8Z" }) });
const UploadIcon = () => jsx('svg', { className: "upload-icon", xmlns: "http://www.w3.org/2000/svg", viewBox: "0 0 24 24", fill: "currentColor", children: jsx('path', { d: "M11 16V7.85l-2.6 2.6L7 9l5-5 5 5-1.4 1.45-2.6-2.6V16h-2Zm-5 4q-.825 0-1.413-.588T4 18v-3h2v3h12v-3h2v3q0 .825-.588 1.413T18 20H6Z" }) });


render(jsx(App, {}), document.getElementById('app'));