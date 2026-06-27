import React, { useState, useEffect, useRef } from 'react';
import { GPSLocation, ChatMessage, MessageContent, AgentStreamChunk } from './types';
import { createAgentSession, streamAgentQuery } from './services/agentService';
import { uploadToHazardBucket } from './services/storageService';
import { CameraModal } from './components/CameraModal';

const USER_ID = `user_${Math.random().toString(36).substring(7)}`;

export default function App() {
  const [gps, setGps] = useState<GPSLocation | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [showCamera, setShowCamera] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  
  const chatEndRef = useRef<HTMLDivElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Initialize Agent Session
  useEffect(() => {
    const initSession = async () => {
      try {
        const id = await createAgentSession(USER_ID);
        setSessionId(id);
        console.log("Agent session created:", id);
      } catch (error: any) {
        console.error("Failed to initialize agent session", error);
        // Add a system message to inform the user
        setMessages(prev => [...prev, {
          id: Date.now().toString(),
          timestamp: Date.now(),
          author: 'agent',
          content: {
            role: 'model',
            parts: [{ text: `System: Failed to connect to the emergency agent. ${error?.message || 'Please check your connection.'}` }]
          }
        }]);
      }
    };
    initSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Hardcode GPS Location to Google Office Shibuya
  useEffect(() => {
    // Simulate a slight delay for realism, then set hardcoded coordinates
    const timer = setTimeout(() => {
      setGps({
        latitude: 35.658034,
        longitude: 139.701636,
        accuracy: 5.0
      });
    }, 1000);

    return () => clearTimeout(timer);
  }, []);

  // Auto-scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSendMessage = async (content: MessageContent) => {
    if (!sessionId) {
      console.warn("No active session");
      return;
    }

    const userMessage: ChatMessage = {
      id: Date.now().toString(),
      timestamp: Date.now(),
      author: 'user',
      content: content
    };

    setMessages(prev => [...prev, userMessage]);
    setIsProcessing(true);
    setInputText('');

    try {
      const stream = streamAgentQuery(sessionId, USER_ID, content);
      
      // Create a placeholder for the agent's response
      const agentMessageId = (Date.now() + 1).toString();
      setMessages(prev => [...prev, {
        id: agentMessageId,
        timestamp: Date.now(),
        author: 'agent',
        content: { role: 'model', parts: [{ text: '' }] }
      }]);

      for await (const chunk of stream) {
        const agentChunk = chunk as AgentStreamChunk;
        if (agentChunk?.content?.parts) {
          const newText = agentChunk.content.parts.map(p => p.text || '').join('');
          
          setMessages(prev => prev.map(msg => {
            if (msg.id === agentMessageId) {
              // Append new text to existing text
              const currentText = msg.content.parts[0]?.text || '';
              return {
                ...msg,
                content: {
                  ...msg.content,
                  parts: [{ text: currentText + newText }]
                }
              };
            }
            return msg;
          }));
        }
      }
    } catch (error: any) {
      console.error("Error sending message to agent:", error);
      setMessages(prev => [...prev, {
        id: Date.now().toString(),
        timestamp: Date.now(),
        author: 'agent',
        content: { role: 'model', parts: [{ text: `System: Error communicating with agent. ${error?.message || ''}` }] }
      }]);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleTextSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!inputText.trim() || isProcessing) return;

    const content: MessageContent = {
      role: 'user',
      parts: [{ text: inputText }]
    };
    
    // Append GPS context if available
    if (gps) {
      content.parts.push({
        text: `\n[Context: User is at Lat: ${gps.latitude.toFixed(4)}, Lng: ${gps.longitude.toFixed(4)}]`
      });
    }

    handleSendMessage(content);
  };

  const handlePhotoCapture = async (base64Data: string) => {
    setShowCamera(false);
    setIsProcessing(true);
    
    try {
      // 1. Upload to bucket (simulated)
      await uploadToHazardBucket(base64Data, 'image/jpeg');
      
      // 2. Send to Agent
      const content: MessageContent = {
        role: 'user',
        parts: [
          { text: "I am reporting a hazard with this image." },
          { inlineData: { mimeType: 'image/jpeg', data: base64Data } }
        ]
      };
      
      if (gps) {
        content.parts.push({
          text: `\n[Context: Image taken at Lat: ${gps.latitude.toFixed(4)}, Lng: ${gps.longitude.toFixed(4)}]`
        });
      }

      await handleSendMessage(content);
    } catch (error: any) {
      console.error("Error handling photo capture:", error);
      setIsProcessing(false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        if (reader.result) {
          const base64String = (reader.result as string).split(',')[1];
          handlePhotoCapture(base64String);
        }
      };
      reader.readAsDataURL(file);
    }
    // Reset input so the same file can be selected again if needed
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const toggleRecording = async () => {
    if (isRecording) {
      // Stop recording
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
      setIsRecording(false);
    } else {
      // Start recording
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mediaRecorder = new MediaRecorder(stream);
        mediaRecorderRef.current = mediaRecorder;
        audioChunksRef.current = [];

        mediaRecorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) {
            audioChunksRef.current.push(e.data);
          }
        };

        mediaRecorder.onstop = async () => {
          const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
          // Convert blob to base64
          const reader = new FileReader();
          reader.readAsDataURL(audioBlob);
          reader.onloadend = () => {
            if (reader.result) {
              const base64data = (reader.result as string).split(',')[1];
              
              const content: MessageContent = {
                role: 'user',
                parts: [
                  { text: "Voice report attached." },
                  { inlineData: { mimeType: 'audio/webm', data: base64data } }
                ]
              };
              handleSendMessage(content);
            }
          };
          
          // Stop all tracks to release mic
          stream.getTracks().forEach(track => track.stop());
        };

        mediaRecorder.start();
        setIsRecording(true);
      } catch (err: any) {
        console.error("Error accessing microphone:", err);
        alert(`Could not access microphone: ${err?.message || 'Unknown error'}`);
      }
    }
  };

  const handleFindSafeBypass = () => {
    // Hardcoded safe bypass coordinates (e.g., Yoyogi Park, a common evacuation area near Shibuya)
    const safeLat = 35.671536;
    const safeLng = 139.696533;
    
    // Open Google Maps in a new tab with the destination set to the safe bypass coordinates
    window.open(`https://www.google.com/maps/dir/?api=1&destination=${safeLat},${safeLng}`, '_blank');
  };

  return (
    <div className="min-h-screen bg-background text-on-surface flex flex-col">
      {/* TopAppBar */}
      <header className="fixed top-0 w-full z-50 bg-background/95 ios-blur border-b border-outline-variant flex items-center justify-between px-container-margin-mobile h-touch-target-min">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-primary pulse-red">emergency</span>
          <h1 className="font-headline-lg-mobile text-headline-lg-mobile font-bold text-primary">Tokyo SafePath</h1>
        </div>
        <div className="flex items-center gap-4">
          <span className={`material-symbols-outlined ${sessionId ? 'text-success' : 'text-on-surface-variant'}`}>
            sensors
          </span>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 mt-16 mb-32 px-container-margin-mobile py-4 flex flex-col gap-stack-md overflow-hidden">
        
        {/* Live Hazard Banner */}
        <div className="shrink-0 w-full bg-error-container text-on-error-container p-4 rounded-xl flex items-center gap-3 border-l-4 border-error shadow-lg">
          <span className="material-symbols-outlined">warning</span>
          <p className="font-label-bold text-label-bold">SHIBUYA AREA: UNSTABLE DEBRIS REPORTED</p>
        </div>

        {/* Bento Grid Layout */}
        <div className="shrink-0 bento-grid">
          {/* Upload Live Hazard - Split into Camera and Local Upload */}
          <div className="col-span-2 grid grid-cols-2 gap-4">
            <button 
              onClick={() => setShowCamera(true)}
              disabled={isProcessing}
              className="relative h-32 bg-surface-container-highest rounded-2xl border-2 border-primary-container p-4 flex flex-col items-center justify-center gap-2 active:scale-[0.98] transition-transform overflow-hidden group disabled:opacity-50"
            >
              <div className="absolute inset-0 bg-primary-container/10 group-hover:bg-primary-container/20 transition-colors"></div>
              <div className="w-12 h-12 bg-primary-container text-on-primary-container rounded-full flex items-center justify-center shadow-lg">
                <span className="material-symbols-outlined !text-[28px]" style={{ fontVariationSettings: "'FILL' 1" }}>photo_camera</span>
              </div>
              <span className="font-title-md text-sm text-on-surface font-bold">Camera</span>
            </button>

            <button 
              onClick={() => fileInputRef.current?.click()}
              disabled={isProcessing}
              className="relative h-32 bg-surface-container-highest rounded-2xl border-2 border-secondary-container p-4 flex flex-col items-center justify-center gap-2 active:scale-[0.98] transition-transform overflow-hidden group disabled:opacity-50"
            >
              <div className="absolute inset-0 bg-secondary-container/10 group-hover:bg-secondary-container/20 transition-colors"></div>
              <div className="w-12 h-12 bg-secondary-container text-on-secondary-container rounded-full flex items-center justify-center shadow-lg">
                <span className="material-symbols-outlined !text-[28px]" style={{ fontVariationSettings: "'FILL' 1" }}>upload_file</span>
              </div>
              <span className="font-title-md text-sm text-on-surface font-bold">Upload</span>
            </button>
            
            {/* Hidden file input for local storage upload */}
            <input 
              type="file" 
              accept="image/*" 
              ref={fileInputRef} 
              className="hidden" 
              onChange={handleFileChange} 
            />
          </div>

          {/* Voice Input Field */}
          <div className="col-span-2 relative">
            <form onSubmit={handleTextSubmit} className="relative w-full">
              <div className="absolute left-4 top-1/2 -translate-y-1/2">
                <span className="material-symbols-outlined text-on-surface-variant">description</span>
              </div>
              <input 
                className="w-full h-touch-target-min bg-surface-container-low border border-outline-variant rounded-xl pl-12 pr-24 text-on-surface placeholder:text-on-surface-variant/50 focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all" 
                placeholder="Describe the situation..." 
                type="text"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                disabled={isProcessing}
              />
              <div className="absolute right-2 top-1/2 -translate-y-1/2 flex gap-1">
                {inputText.trim() ? (
                  <button 
                    type="submit"
                    disabled={isProcessing}
                    className="w-10 h-10 flex items-center justify-center text-primary active:scale-90 transition-transform disabled:opacity-50"
                  >
                    <span className="material-symbols-outlined">send</span>
                  </button>
                ) : (
                  <button 
                    type="button"
                    onClick={toggleRecording}
                    disabled={isProcessing}
                    className={`w-10 h-10 flex items-center justify-center rounded-full active:scale-90 transition-all ${isRecording ? 'bg-error text-on-error animate-pulse' : 'text-primary'}`}
                  >
                    <span className="material-symbols-outlined">mic</span>
                  </button>
                )}
              </div>
            </form>
          </div>

          {/* GPS Status Card */}
          <div className="col-span-2 bg-surface-container border border-outline-variant rounded-xl p-3 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${gps ? 'bg-tertiary-container/20' : 'bg-surface-variant'}`}>
                <span className={`material-symbols-outlined ${gps ? 'text-tertiary' : 'text-on-surface-variant'}`}>gps_fixed</span>
              </div>
              <div>
                <p className="font-label-bold text-label-bold text-on-surface">
                  {gps ? 'Location: Shibuya' : 'Locating...'}
                </p>
                <p className="text-[10px] uppercase tracking-widest text-tertiary">
                  {gps ? `Google Office (Precision: ${gps.accuracy?.toFixed(1) || '5.0'}m)` : 'Waiting for signal'}
                </p>
              </div>
            </div>
            {gps && (
              <div className="flex items-center gap-1">
                <div className="w-1.5 h-1.5 rounded-full bg-tertiary animate-pulse"></div>
                <div className="w-1.5 h-1.5 rounded-full bg-tertiary animate-pulse" style={{ animationDelay: '0.2s' }}></div>
                <div className="w-1.5 h-1.5 rounded-full bg-tertiary animate-pulse" style={{ animationDelay: '0.4s' }}></div>
              </div>
            )}
          </div>
        </div>

        {/* Chat Interface */}
        <div className="flex-1 bg-surface-container-low border border-outline-variant rounded-xl p-4 overflow-y-auto chat-scroll flex flex-col gap-4 min-h-[200px]">
          {messages.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center text-on-surface-variant opacity-50">
              <span className="material-symbols-outlined text-4xl mb-2">support_agent</span>
              <p className="text-center text-sm">Emergency Agent is ready.<br/>Report hazards or ask for guidance.</p>
            </div>
          ) : (
            messages.map((msg) => (
              <div key={msg.id} className={`flex flex-col max-w-[85%] ${msg.author === 'user' ? 'self-end items-end' : 'self-start items-start'}`}>
                <div className={`p-3 rounded-2xl ${
                  msg.author === 'user' 
                    ? 'bg-primary-container text-on-primary-container rounded-tr-sm' 
                    : 'bg-surface-variant text-on-surface-variant rounded-tl-sm'
                }`}>
                  {/* Render text parts */}
                  {msg.content?.parts?.map((part, idx) => {
                    if (part.text) {
                      // Simple markdown-like rendering for bold text often returned by agents
                      const formattedText = part.text.split('**').map((chunk, i) => 
                        i % 2 === 1 ? <strong key={i}>{chunk}</strong> : chunk
                      );
                      return <p key={idx} className="whitespace-pre-wrap text-sm">{formattedText}</p>;
                    }
                    if (part.inlineData) {
                      if (part.inlineData.mimeType.startsWith('image/')) {
                        return <img key={idx} src={`data:${part.inlineData.mimeType};base64,${part.inlineData.data}`} alt="Uploaded hazard" className="mt-2 rounded-lg max-w-full h-auto border border-outline/20" />;
                      }
                      if (part.inlineData.mimeType.startsWith('audio/')) {
                        return (
                          <div key={idx} className="flex items-center gap-2 mt-2 bg-black/10 p-2 rounded-lg">
                            <span className="material-symbols-outlined">graphic_eq</span>
                            <span className="text-xs font-medium">Voice Note Attached</span>
                          </div>
                        );
                      }
                    }
                    return null;
                  })}
                </div>
                <span className="text-[10px] text-on-surface-variant/50 mt-1 px-1">
                  {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            ))
          )}
          {isProcessing && messages[messages.length - 1]?.author === 'user' && (
            <div className="self-start flex items-center gap-2 text-on-surface-variant p-2">
              <div className="w-2 h-2 bg-primary rounded-full animate-bounce"></div>
              <div className="w-2 h-2 bg-primary rounded-full animate-bounce" style={{ animationDelay: '0.2s' }}></div>
              <div className="w-2 h-2 bg-primary rounded-full animate-bounce" style={{ animationDelay: '0.4s' }}></div>
            </div>
          )}
          <div ref={chatEndRef} />
        </div>

      </main>

      {/* Bottom Navigation & Fixed Actions */}
      <div className="fixed bottom-0 w-full z-50 bg-background/90 ios-blur">
        {/* Floating Primary Action Button */}
        <div className="px-container-margin-mobile pb-4">
          <button 
            onClick={handleFindSafeBypass}
            className="w-full h-14 bg-primary-container text-on-primary-container rounded-2xl flex items-center justify-center gap-3 shadow-2xl active:scale-[0.97] transition-all border border-primary/20"
          >
            <span className="material-symbols-outlined !text-[24px]">route</span>
            <span className="font-title-md text-base font-extrabold uppercase tracking-tight">Find Safe Bypass</span>
          </button>
        </div>
        
        {/* BottomNavBar Components */}
        <nav className="w-full h-16 flex justify-around items-center px-gutter bg-surface border-t border-outline-variant pb-safe">
          <button className="flex flex-col items-center justify-center text-on-surface-variant px-4 py-1 active:scale-95 transition-transform">
            <span className="material-symbols-outlined">directions_run</span>
            <span className="font-label-sm text-[10px]">Evacuate</span>
          </button>
          <button className="flex flex-col items-center justify-center bg-primary-container text-on-primary-container rounded-xl px-4 py-1 active:scale-95 transition-transform">
            <span className="material-symbols-outlined" style={{ fontVariationSettings: "'FILL' 1" }}>add_a_photo</span>
            <span className="font-label-sm text-[10px]">Report</span>
          </button>
          <button className="flex flex-col items-center justify-center text-on-surface-variant px-4 py-1 active:scale-95 transition-transform">
            <span className="material-symbols-outlined">map</span>
            <span className="font-label-sm text-[10px]">Map</span>
          </button>
          <button className="flex flex-col items-center justify-center text-on-surface-variant px-4 py-1 active:scale-95 transition-transform">
            <span className="material-symbols-outlined">person</span>
            <span className="font-label-sm text-[10px]">Profile</span>
          </button>
        </nav>
      </div>

      {/* Camera Modal */}
      {showCamera && (
        <CameraModal 
          onCapture={handlePhotoCapture} 
          onClose={() => setShowCamera(false)} 
        />
      )}
    </div>
  );
}
