import { GoogleGenAI, LiveServerMessage, Modality } from "@google/genai";

export class LiveAudioService {
  private ai: GoogleGenAI;
  private session: any = null;
  private audioContext: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private stream: MediaStream | null = null;
  private workletNode: AudioWorkletNode | null = null;

  constructor() {
    this.ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }

  async connect(callbacks: {
    onopen?: () => void;
    onmessage: (message: LiveServerMessage) => void;
    onerror?: (error: any) => void;
    onclose?: () => void;
  }, systemInstruction: string) {
    this.session = await this.ai.live.connect({
      model: "gemini-2.5-flash-native-audio-preview-09-2025",
      callbacks,
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: "Zephyr" } },
        },
        systemInstruction,
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
    });
    return this.session;
  }

  async sendText(text: string) {
    if (!this.session) return;
    this.session.sendRealtimeInput({
      text
    });
  }

  async startMicrophone() {
    try {
      if (!this.audioContext) {
        this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      }
      
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }

      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.source = this.audioContext.createMediaStreamSource(this.stream);

      this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);
      
      this.processor.onaudioprocess = (e) => {
        if (!this.session) return;
        
        const inputData = e.inputBuffer.getChannelData(0);
        const pcmData = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          pcmData[i] = Math.max(-1, Math.min(1, inputData[i])) * 0x7FFF;
        }
        
        // More efficient base64 conversion
        const uint8Array = new Uint8Array(pcmData.buffer);
        const base64Data = btoa(String.fromCharCode.apply(null, uint8Array as any));

        this.session.sendRealtimeInput({
          media: { data: base64Data, mimeType: 'audio/pcm;rate=16000' }
        });
      };

      this.source.connect(this.processor);
      this.processor.connect(this.audioContext.destination);
      return this.stream;
    } catch (err) {
      console.error("Error starting microphone:", err);
      throw err;
    }
  }

  stopMicrophone() {
    if (this.processor) {
      this.processor.disconnect();
      this.processor = null;
    }
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
  }

  async disconnect() {
    this.stopMicrophone();
    if (this.session) {
      await this.session.close();
      this.session = null;
    }
  }
}
