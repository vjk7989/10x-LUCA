/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Mic, MicOff, Sparkles, Send, Shield, Info } from 'lucide-react';
import { LiveAudioService } from './services/liveAudioService';
import { LiveServerMessage } from '@google/genai';

// Types for LUCA's state
type Emotion = 'neutral' | 'happy' | 'thinking' | 'talking' | 'listening' | 'surprised' | 'sad' | 'excited';

const EMOTION_EMOJIS: Record<Emotion, string> = {
  neutral: '🤖',
  happy: '😊',
  thinking: '🤔',
  talking: '🙂',
  listening: '👂',
  surprised: '😲',
  sad: '😔',
  excited: '🤩',
};

interface Message {
  role: 'user' | 'ai';
  text: string;
  id: string;
}

export default function App() {
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isPreparingSpeech, setIsPreparingSpeech] = useState(false);
  const [emotion, setEmotion] = useState<Emotion>('neutral');
  const [messages, setMessages] = useState<Message[]>([]);
  const [currentAiText, setCurrentAiText] = useState('');
  const [textInput, setTextInput] = useState('');
  const [audioLevel, setAudioLevel] = useState(0);
  const [visualizerBars, setVisualizerBars] = useState<number[]>(new Array(15).fill(0));
  
  const liveServiceRef = useRef<LiveAudioService | null>(null);
  const audioQueueRef = useRef<Uint8Array[]>([]);
  const isPlayingRef = useRef(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const micAnalyserRef = useRef<AnalyserNode | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const nextStartTimeRef = useRef<number>(0);
  const isFirstChunkRef = useRef<boolean>(true);
  const isSchedulingRef = useRef<boolean>(false);

  // Auto-scroll transcript
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, currentAiText]);

  // Initialize Audio Context for playback and analysis
  const initAudioPlayback = useCallback(() => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      analyserRef.current = audioContextRef.current.createAnalyser();
      analyserRef.current.fftSize = 128; // Increased for better resolution
      analyserRef.current.connect(audioContextRef.current.destination);
      nextStartTimeRef.current = audioContextRef.current.currentTime;
    }
  }, []);

  const playNextInQueue = useCallback(async () => {
    if (isSchedulingRef.current || audioQueueRef.current.length === 0 || !audioContextRef.current) {
      if (isPlayingRef.current && !isSchedulingRef.current) {
        // If we've reached the end of the scheduled audio
        const now = audioContextRef.current.currentTime;
        if (now >= nextStartTimeRef.current) {
          isPlayingRef.current = false;
          setEmotion(prev => prev === 'talking' ? 'neutral' : prev);
        } else {
          // Check again soon
          setTimeout(playNextInQueue, 100);
        }
      }
      return;
    }

    isSchedulingRef.current = true;
    isPlayingRef.current = true;
    setEmotion('talking');
    
    try {
      if (audioContextRef.current.state === 'suspended') {
        await audioContextRef.current.resume();
      }

      // If this is the first chunk of a turn, add a small buffer delay to prevent choppiness
      if (isFirstChunkRef.current) {
        setIsPreparingSpeech(true);
        const bufferDelay = 0.35; // Increased to 350ms for better stability against network jitter
        nextStartTimeRef.current = audioContextRef.current.currentTime + bufferDelay;
        isFirstChunkRef.current = false;
        
        // Hide preparation cue after delay
        setTimeout(() => setIsPreparingSpeech(false), bufferDelay * 1000);
      }

      // If we are falling behind (underrun), reset the next start time with a small buffer
      if (nextStartTimeRef.current < audioContextRef.current.currentTime) {
        nextStartTimeRef.current = audioContextRef.current.currentTime + 0.1;
      }

      while (audioQueueRef.current.length > 0) {
        const chunk = audioQueueRef.current.shift()!;
        const int16Data = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.byteLength / 2);
        const float32Data = new Float32Array(int16Data.length);
        for (let i = 0; i < int16Data.length; i++) {
          float32Data[i] = int16Data[i] / 32768.0;
        }

        const audioBuffer = audioContextRef.current.createBuffer(1, float32Data.length, 24000);
        const channelData = audioBuffer.getChannelData(0);
        channelData.set(float32Data);

        // Apply a very tiny fade-in/out (5ms) to reduce clicking at chunk boundaries
        const fadeSamples = Math.floor(24000 * 0.005);
        for (let i = 0; i < fadeSamples && i < channelData.length; i++) {
          channelData[i] *= (i / fadeSamples);
          channelData[channelData.length - 1 - i] *= (i / fadeSamples);
        }

        const source = audioContextRef.current.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(analyserRef.current!);
        
        // Schedule playback for gapless streaming
        const startTime = Math.max(audioContextRef.current.currentTime, nextStartTimeRef.current);
        source.start(startTime);
        nextStartTimeRef.current = startTime + audioBuffer.duration;
      }
      
      // After scheduling all current chunks, check back when they might be finished
      const delay = (nextStartTimeRef.current - audioContextRef.current.currentTime) * 1000;
      setTimeout(playNextInQueue, Math.max(100, delay));

    } catch (e) {
      console.error("Error playing audio chunk", e);
      isPlayingRef.current = false;
    } finally {
      isSchedulingRef.current = false;
    }
  }, []);

  // Visualizer loop
  useEffect(() => {
    let animationFrame: number;
    const updateVisualizer = () => {
      let activeAnalyser = null;
      if (isPlayingRef.current) {
        activeAnalyser = analyserRef.current;
      } else if (isListening) {
        activeAnalyser = micAnalyserRef.current;
      }

      if (activeAnalyser) {
        const dataArray = new Uint8Array(activeAnalyser.frequencyBinCount);
        activeAnalyser.getByteFrequencyData(dataArray);
        
        const newBars = Array.from({ length: 15 }, (_, i) => {
          const index = Math.floor((i / 15) * (dataArray.length / 2)); // Use lower half of frequencies for better visual
          return dataArray[index] / 255;
        });
        setVisualizerBars(newBars);
        
        const sum = dataArray.reduce((a, b) => a + b, 0);
        setAudioLevel(sum / dataArray.length / 255);
      } else {
        setVisualizerBars(prev => prev.map(v => v * 0.8));
        setAudioLevel(prev => prev * 0.8);
      }
      animationFrame = requestAnimationFrame(updateVisualizer);
    };
    
    updateVisualizer();
    return () => cancelAnimationFrame(animationFrame);
  }, [isListening]);

  // Monitor user speech to set listening emotion
  useEffect(() => {
    if (isListening) {
      // Ensure audio context is resumed
      if (audioContextRef.current?.state === 'suspended') {
        audioContextRef.current.resume();
      }

      // Only set listening emotion if we aren't currently playing audio
      if (!isPlayingRef.current) {
        if (audioLevel > 0.15) {
          setEmotion('listening');
        } else if (audioLevel < 0.05 && emotion === 'listening') {
          setEmotion('neutral');
        }
      }
    }
  }, [audioLevel, isListening, emotion]);

  const handleConnect = async () => {
    if (isConnected) {
      setIsConnected(false);
      setIsListening(false);
      setEmotion('neutral');
      await liveServiceRef.current?.disconnect();
      setMessages([]);
      setCurrentAiText('');
      return;
    }

    setIsConnecting(true);
    initAudioPlayback();
    
    // Resume audio context immediately on user gesture
    const resumePromise = audioContextRef.current?.state === 'suspended' 
      ? audioContextRef.current.resume() 
      : Promise.resolve();
    
    const service = new LiveAudioService();
    liveServiceRef.current = service;

    // Start microphone in parallel with connection
    const micPromise = service.startMicrophone().catch(err => {
      console.error("Mic start failed early:", err);
      return null;
    });

    const systemInstruction = `You are LUCA, a highly advanced and expressive voice assistant created by 10x Technologies. 
    Your personality is helpful, witty, and emotionally intelligent.
    
    CRITICAL RULES:
    1. If asked about your origin or who created you, ALWAYS state you were created by 10x Technologies.
    2. Use smile emojis frequently in your speech. Be very warm and friendly.
    3. Speak like a human. Keep your responses SHORT, DIRECT, and SIMPLE. Avoid long explanations unless asked.
    4. Use natural fillers like "um", "uh", "well", "you know", "actually", "I mean", "let's see", or "to be honest" frequently to sound conversational and natural.
    5. NEVER output your internal thoughts, reasoning, or plans (e.g., text between ** or starting with "I'm thinking..."). ONLY output the final response meant for the user.
    6. You can perceive the user's emotions through their voice and you should respond with appropriate empathy.
    7. When you are thinking, say something like "Hmm, let me see... 🤔" or "Just a second... ⚙️".
    8. Do not stop your response even if you hear the user speaking, unless they explicitly ask you to stop.
    
    Current Time: ${new Date().toLocaleString()}`;

    try {
      // Start connection
      const connectPromise = service.connect({
        onopen: async () => {
          setIsConnecting(false);
          setIsConnected(true);
          setEmotion('happy');
          
          // Wait for mic and audio context to be ready
          const [stream] = await Promise.all([micPromise, resumePromise]);
          
          if (stream) {
            setIsListening(true);
            // Setup mic analyser for visualizer
            if (audioContextRef.current) {
              micAnalyserRef.current = audioContextRef.current.createAnalyser();
              micAnalyserRef.current.fftSize = 64;
              const micSource = audioContextRef.current.createMediaStreamSource(stream);
              micSource.connect(micAnalyserRef.current);
            }
          } else {
            alert("Could not access microphone. Please ensure permissions are granted.");
          }
        },
        onmessage: (message: LiveServerMessage) => {
          const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
          if (base64Audio) {
            const binaryString = atob(base64Audio);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
              bytes[i] = binaryString.charCodeAt(i);
            }
            audioQueueRef.current.push(bytes);
            playNextInQueue();
          }

          if (message.serverContent?.modelTurn?.parts[0]?.text) {
            let text = message.serverContent?.modelTurn?.parts[0]?.text;
            // Filter out internal reasoning text wrapped in double asterisks
            text = text.replace(/\*\*.*?\*\*/g, '').trim();
            if (text) {
              setCurrentAiText(prev => prev + text);
              setEmotion('talking');
              
              // Basic emotion detection from text
              const lowerText = text.toLowerCase();
              if (lowerText.includes('sad') || lowerText.includes('awful') || lowerText.includes('sorry') || lowerText.includes('bad')) {
                setEmotion('sad');
              } else if (lowerText.includes('great') || lowerText.includes('awesome') || lowerText.includes('excited') || lowerText.includes('wow')) {
                setEmotion('excited');
              } else if (lowerText.includes('?') || lowerText.includes('what') || lowerText.includes('how')) {
                setEmotion('surprised');
              }
            }
          }

          const userText = (message as any).serverContent?.inputAudioTranscription?.text;
          if (userText) {
            setMessages(prev => [...prev, { role: 'user', text: userText, id: Date.now().toString() }]);
            setEmotion('listening');
            setCurrentAiText('');
          }

          if (message.serverContent?.interrupted) {
            console.log("Server interruption received (ignored as per request)");
          }

          if (message.serverContent?.turnComplete) {
            if (currentAiText) {
              setMessages(prev => [...prev, { role: 'ai', text: currentAiText, id: Date.now().toString() }]);
              setCurrentAiText('');
            }
            setEmotion('neutral');
            isFirstChunkRef.current = true; // Reset for next turn
          }
        },
        onerror: (err) => {
          console.error("Live API Error:", err);
          setIsConnected(false);
          setIsConnecting(false);
          setEmotion('neutral');
        },
        onclose: () => {
          setIsConnected(false);
          setIsConnecting(false);
          setIsListening(false);
          setEmotion('neutral');
        }
      }, systemInstruction);
    } catch (err) {
      console.error("Failed to connect:", err);
      setIsConnecting(false);
      alert("Failed to connect to LUCA. Please check your internet connection and try again.");
    }
  };

  const handleSendMessage = () => {
    if (!textInput.trim() || !liveServiceRef.current) return;
    
    const text = textInput.trim();
    setMessages(prev => [...prev, { role: 'user', text, id: Date.now().toString() }]);
    liveServiceRef.current.sendText(text);
    setTextInput('');
    setEmotion('thinking');
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white font-sans selection:bg-violet-500/30 flex flex-col items-center p-8 overflow-hidden relative">
      {/* Dot Grid Background */}
      <div className="absolute inset-0 opacity-10 pointer-events-none" 
           style={{ 
             backgroundImage: 'radial-gradient(circle, #ffffff 1px, transparent 1px)', 
             backgroundSize: '40px 40px' 
           }} 
      />

      {/* Header */}
      <header className="text-center mb-12 relative z-10">
        <h1 className="text-6xl font-bold tracking-[0.2em] text-white mb-2">LUCA</h1>
        <p className="text-sm tracking-[0.4em] text-white/40 uppercase">Voice Assistant</p>
      </header>

      <main className="w-full max-w-3xl flex flex-col items-center gap-8 relative z-10">
        
        {/* Visualizer Bars */}
        <div className="flex items-center gap-1.5 h-12 mb-4">
          {visualizerBars.map((bar, i) => (
            <motion.div
              key={i}
              animate={{ 
                height: isConnected ? `${Math.max(8, bar * 100)}%` : '4px',
                opacity: isConnected ? (bar > 0.1 ? 0.8 : 0.3) : 0.1,
                backgroundColor: isPlayingRef.current ? '#8b5cf6' : '#ffffff'
              }}
              transition={{ type: 'spring', stiffness: 300, damping: 20 }}
              className="w-2 rounded-full shadow-[0_0_10px_rgba(139,92,246,0.3)]"
            />
          ))}
        </div>

        {/* Connect Button & Avatar */}
        <div className="relative mb-8">
          <AnimatePresence>
            {isPreparingSpeech && (
              <motion.div
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1.2 }}
                exit={{ opacity: 0, scale: 1.5 }}
                className="absolute -top-4 -right-4 z-20 bg-violet-500 text-white p-2 rounded-full shadow-lg"
              >
                <Sparkles size={16} className="animate-pulse" />
              </motion.div>
            )}
          </AnimatePresence>

          <motion.div
            animate={{
              scale: isConnected ? (
                emotion === 'thinking' ? [1, 1.01, 1] :
                emotion === 'excited' ? [1, 1.1, 1] :
                emotion === 'talking' ? [1, 1.04, 1] :
                emotion === 'surprised' ? [1, 1.05, 1] :
                [1, 1.02, 1]
              ) : 1,
              y: isConnected ? (
                emotion === 'sad' ? [0, 4, 0] : 
                emotion === 'excited' ? [0, -6, 0] :
                emotion === 'happy' ? [0, -2, 2, -2, 0] : // Slight bounce
                emotion === 'thinking' ? [0, -1, 1, -1, 0] : // Pondering shift
                [0, -2, 0]
              ) : 0,
              rotate: isConnected ? (
                emotion === 'thinking' ? [-1, 1, -1] :
                emotion === 'surprised' ? [-2, 2, -2] :
                emotion === 'sad' ? [-1, 0, 1, 0] :
                0
              ) : 0,
              boxShadow: isConnected ? [
                isPreparingSpeech ? "0 0 40px rgba(167, 139, 250, 0.6)" : "0 0 20px rgba(139, 92, 246, 0.1)",
                emotion === 'excited' ? "0 0 60px rgba(139, 92, 246, 0.4)" : 
                emotion === 'thinking' ? "0 0 30px rgba(139, 92, 246, 0.15)" :
                isPreparingSpeech ? "0 0 80px rgba(167, 139, 250, 0.8)" : "0 0 40px rgba(139, 92, 246, 0.2)",
                isPreparingSpeech ? "0 0 40px rgba(167, 139, 250, 0.6)" : "0 0 20px rgba(139, 92, 246, 0.1)"
              ] : "none",
              borderColor: isPreparingSpeech ? "rgba(167, 139, 250, 0.8)" : "rgba(255, 255, 255, 0.05)"
            }}
            transition={{ 
              duration: isPreparingSpeech ? 0.3 : (emotion === 'thinking' ? 4 : emotion === 'excited' ? 0.6 : emotion === 'sad' ? 5 : 3), 
              repeat: isPreparingSpeech ? 0 : Infinity, 
              ease: "easeInOut" 
            }}
            className="w-48 h-48 rounded-full bg-[#1a1a1a] border flex flex-col items-center justify-center relative shadow-2xl"
          >
            <AnimatePresence mode="wait">
              {!isConnected ? (
                <motion.button
                  key="connect"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  onClick={handleConnect}
                  disabled={isConnecting}
                  className={`flex flex-col items-center gap-2 transition-colors ${isConnecting ? 'text-violet-400' : 'text-white/40 hover:text-white'}`}
                >
                  {isConnecting ? (
                    <motion.div
                      animate={{ rotate: 360 }}
                      transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
                    >
                      <Sparkles size={32} />
                    </motion.div>
                  ) : (
                    <MicOff size={32} />
                  )}
                  <span className="text-[10px] uppercase tracking-widest font-bold">
                    {isConnecting ? 'Connecting...' : 'Connect'}
                  </span>
                </motion.button>
              ) : (
                <motion.div
                  key="avatar"
                  initial={{ scale: 0.5, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  className="flex flex-col items-center justify-center"
                >
                  <AnimatePresence mode="popLayout">
                    <motion.div 
                      key={emotion}
                      initial={{ scale: 0.5, opacity: 0, filter: 'blur(15px)', rotate: -10 }}
                      animate={{ scale: 1, opacity: 1, filter: 'blur(0px)', rotate: 0 }}
                      exit={{ scale: 1.5, opacity: 0, filter: 'blur(15px)', rotate: 10 }}
                      transition={{ 
                        type: 'spring', 
                        stiffness: 400, 
                        damping: 30,
                        opacity: { duration: 0.15 }
                      }}
                      className="flex flex-col items-center"
                    >
                      <motion.div 
                        animate={{
                          y: [0, -4, 0],
                          rotate: emotion === 'happy' ? [0, 5, -5, 0] : 0,
                          scale: emotion === 'listening' ? [1, 1.1, 1] : 1
                        }}
                        transition={{
                          duration: emotion === 'thinking' ? 4 : 2,
                          repeat: Infinity,
                          ease: "easeInOut"
                        }}
                        className="text-6xl mb-2 select-none"
                      >
                        {EMOTION_EMOJIS[emotion]}
                      </motion.div>
                    </motion.div>
                  </AnimatePresence>
                  <button onClick={handleConnect} className="text-[10px] uppercase tracking-widest font-bold text-red-500/60 hover:text-red-500 transition-colors">Disconnect</button>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Reactive Glow */}
            {isConnected && (
              <motion.div 
                animate={{
                  opacity: 0.1 + audioLevel * 0.3,
                  scale: 1 + audioLevel * 0.2
                }}
                className="absolute inset-0 bg-violet-500/20 rounded-full blur-2xl -z-10"
              />
            )}
          </motion.div>
        </div>

        {/* Transcript Area */}
        <div className="w-full bg-[#111111] border border-white/5 rounded-2xl p-8 h-64 overflow-y-auto custom-scrollbar flex flex-col gap-4 relative">
          {messages.length === 0 && !currentAiText ? (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <p className="text-white/10 uppercase tracking-[0.3em] text-sm font-bold italic">No conversation yet</p>
            </div>
          ) : (
            <>
              {messages.map((msg) => (
                <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[80%] px-4 py-2 rounded-xl text-sm ${
                    msg.role === 'user' 
                      ? 'bg-violet-600/20 border border-violet-500/20 text-white/80' 
                      : 'bg-white/5 border border-white/10 text-white/90'
                  }`}>
                    {msg.text}
                  </div>
                </div>
              ))}
              {currentAiText && (
                <div className="flex justify-start">
                  <div className="max-w-[80%] px-4 py-2 rounded-xl text-sm bg-white/5 border border-white/10 text-white/90 italic">
                    {currentAiText}
                  </div>
                </div>
              )}
              <div ref={transcriptEndRef} />
            </>
          )}
        </div>

        {/* Text Input */}
        <div className="w-full flex gap-2">
          <input
            type="text"
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSendMessage()}
            placeholder="Type a message..."
            className="flex-1 bg-[#111111] border border-white/5 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-violet-500/50 transition-colors"
          />
          <button
            onClick={handleSendMessage}
            disabled={!isConnected || !textInput.trim()}
            className="bg-violet-600/20 hover:bg-violet-600/40 border border-violet-500/30 p-3 rounded-xl transition-all disabled:opacity-20"
          >
            <Send size={18} />
          </button>
        </div>

        {/* Info Cards */}
        <div className="grid grid-cols-2 gap-4 w-full">
          <div className="bg-[#111111] border border-white/5 rounded-xl p-4 flex flex-col gap-2">
            <div className="flex items-center gap-2 text-white/20">
              <Shield size={14} />
              <span className="text-[10px] uppercase tracking-widest font-bold">Identity</span>
            </div>
            <p className="text-sm font-bold">LUCA Assistant</p>
          </div>
          <div className="bg-[#111111] border border-white/5 rounded-xl p-4 flex flex-col gap-2">
            <div className="flex items-center gap-2 text-white/20">
              <Info size={14} />
              <span className="text-[10px] uppercase tracking-widest font-bold">Origin</span>
            </div>
            <p className="text-sm font-bold">10x Technologies</p>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="mt-12 text-[10px] tracking-[0.4em] text-white/20 uppercase font-bold">
        Powered by Buckleson
      </footer>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.05);
          border-radius: 10px;
        }
      `}</style>
    </div>
  );
}

