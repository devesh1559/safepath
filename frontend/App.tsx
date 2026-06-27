import React, { useState, useEffect, useRef } from 'react';
import { GPSLocation, ChatMessage, MessageContent, AgentStreamChunk, SafeLocation } from './types';
import { createAgentSession, streamAgentQuery } from './services/agentService';
import { uploadToHazardBucket } from './services/storageService';
import { CameraModal } from './components/CameraModal';

const USER_ID = `user_${Math.random().toString(36).substring(7)}`;

// Helper to calculate distance between two coordinates in km
function getDistanceFromLatLonInKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371; // Radius of the earth in km
  const dLat = deg2rad(lat2 - lat1);
  const dLon = deg2rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function deg2rad(deg: number) {
  return deg * (Math.PI / 180);
}

// Helper to extract locations from agent text
const extractLocations = (text: string): SafeLocation[] => {
  const locations: SafeLocation[] = [];
  // Look for coordinates: lat, lng
  const coordRegex = /(-?\d{1,2}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})/g;
  let match;
  let i = 1;
  
  while ((match = coordRegex.exec(text)) !== null) {
    // Try to extract a name from the preceding 30 characters
    const precedingText = text.substring(Math.max(0, match.index - 40), match.index);
    const nameMatch = precedingText.match(/([A-Z][a-zA-Z0-9\s]+)[\s:(]*$/);
    const name = nameMatch ? nameMatch[1].trim() : `Safe Location ${i}`;
    
    locations.push({
      id: `loc-${Date.now()}-${i}`,
      name: name,
      lat: parseFloat(match[1]),
      lng: parseFloat(match[2])
    });
    i++;
  }
  return locations;
};

export default function App() {
  const [gps, setGps] = useState<GPSLocation | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [showCamera, setShowCamera] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isWaitingForResponse, setIsWaitingForResponse] = useState(false);
  
  // Safe Locations State
  const [safeLocations, setSafeLocations] = useState<SafeLocation[]>([]);
  const [selectedLocation, setSelectedLocation] = useState<SafeLocation | null>(null);
  
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
        // Set a fallback session ID so the user can still attempt to send messages
        setSessionId(`fallback_${Date.now()}`);
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
  }, [messages, isWaitingForResponse]);

  // Parse agent messages for safe locations when processing finishes
  useEffect(() => {
    if (!isProcessing && messages.length > 0) {
      const lastMessage = messages[messages.length - 1];
      if (lastMessage.author === 'agent') {
        const text = lastMessage.content.parts.map(p => p.text || '').join('\n');
        const extracted = extractLocations(text);
        
        if (extracted.length > 0) {
          // Calculate distances if GPS is available
          const withDistances = extracted.map(loc => {
            if (gps) {
              return { 
                ...loc, 
                distance: getDistanceFromLatLonInKm(gps.latitude, gps.longitude, loc.lat, loc.lng) 
              };
            }
            return loc;
          });
          
          // Sort by distance (nearest first)
          withDistances.sort((a, b) => (a.distance || 0) - (b.distance || 0));
          
          setSafeLocations(withDistances);
          setSelectedLocation(withDistances[0]); // Select nearest by default
        }
      }
    }
  }, [isProcessing, messages, gps]);

  const handleSendMessage = async (content: MessageContent) => {
    const currentSessionId = sessionId || `fallback_${Date.now()}`;

    const userMessage: ChatMessage = {
      id: Date.now().toString(),
      timestamp: Date.now(),
      author: 'user',
      content: content
    };

    setMessages(prev => [...prev, userMessage]);
    setIsProcessing(true);
    setIsWaitingForResponse(true);
    setInputText('');

    try {
      const stream = streamAgentQuery(currentSessionId, USER_ID, content);
      let agentMessageId: string | null = null;

      for await (const chunk of stream) {
        const agentChunk = chunk as AgentStreamChunk;
        if (agentChunk?.content?.parts) {
          const newText = agentChunk.content.parts.map(p => p.text || '').join('');
          
          if (!agentMessageId) {
            // First chunk received, hide loader and create the agent message bubble
            setIsWaitingForResponse(false);
            agentMessageId = (Date.now() + 1).toString();
            setMessages(prev => [...prev, {
              id: agentMessageId!,
              timestamp: Date.now(),
              author: 'agent',
              content: { role: 'model', parts: [{ text: newText }] }
            }]);
          } else {
            // Subsequent chunks, append to the existing bubble
            setMessages(prev => prev.map(msg => {
              if (msg.id === agentMessageId) {
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
      }
    } catch (error: any) {
      console.error("Error sending message to agent:", error);
      setIsWaitingForResponse(false);
      setMessages(prev => [...prev, {
        id: Date.now().toString(),
        timestamp: Date.now(),
        author: 'agent',
        content: { role: 'model', parts: [{ text: `System: Error communicating with agent. ${error?.message || ''}` }] }
      }]);
    } finally {
      setIsProcessing(false);
      setIsWaitingForResponse(false);
    }
  };

  const handleTextSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!inputText.trim() || isProcessing) return;

    const content: MessageContent = {
      role: 'user',
      parts: [{ text: inputText }]
    };
    
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
    setIsWaitingForResponse(true);
    
    try {
      await uploadToHazardBucket(base64Data, 'image/jpeg');
      
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
      setIsWaitingForResponse(false);
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
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const toggleRecording = async () => {
    if (isRecording) {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
      setIsRecording(false);
    } else {
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
    if (!selectedLocation) return;
    window.open(`https://www.google.com/maps/dir/?api=1&destination=${selectedLocation.lat},${selectedLocation.lng}`, '_blank');
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
          <span className={`material-symbols-outlined ${sessionId && !sessionId.startsWith('fallback') ? 'text-success' : 'text-on-surface-variant'}`}>
            sensors
          </span>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 mt-16 mb-48 px-container-margin-mobile py-4 flex flex-col gap-stack-md overflow-hidden">
        
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
          
          {/* Loader shown while waiting for the first chunk from the agent */}
          {isWaitingForResponse && (
            <div className="self-start flex flex-col max-w-[85%] items-start">
              <div className="p-4 bg-surface-variant text-on-surface-variant rounded-2xl rounded-tl-sm flex items-center gap-1.5 h-11">
                <div className="w-2 h-2 bg-on-surface-variant/70 rounded-full animate-bounce"></div>
                <div className="w-2 h-2 bg-on-surface-variant/70 rounded-full animate-bounce" style={{ animationDelay: '0.15s' }}></div>
                <div className="w-2 h-2 bg-on-surface-variant/70 rounded-full animate-bounce" style={{ animationDelay: '0.3s' }}></div>
              </div>
            </div>
          )}
          <div ref={chatEndRef} />
        </div>

      </main>

      {/* Bottom Navigation & Fixed Actions */}
      <div className="fixed bottom-0 w-full z-50 bg-background/90 ios-blur flex flex-col">
        
        {/* Safe Locations List */}
        {safeLocations.length > 0 && (
          <div className="px-container-margin-mobile pt-2 pb-2 w-full overflow-x-auto flex gap-2 no-scrollbar">
            {safeLocations.map(loc => (
              <button
                key={loc.id}
                onClick={() => setSelectedLocation(loc)}
                className={`flex-shrink-0 px-4 py-2 rounded-xl border text-left min-w-[120px] transition-colors ${
                  selectedLocation?.id === loc.id 
                    ? 'bg-primary-container border-primary text-on-primary-container' 
                    : 'bg-surface-container-high border-outline-variant text-on-surface'
                }`}
              >
                <div className="font-label-bold text-sm truncate">{loc.name}</div>
                <div className="text-[10px] opacity-80">{loc.distance ? `${loc.distance.toFixed(1)} km away` : 'Unknown distance'}</div>
              </button>
            ))}
          </div>
        )}

        {/* Floating Primary Action Button */}
        <div className="px-container-margin-mobile pb-4 pt-2">
          <button 
            onClick={handleFindSafeBypass}
            disabled={safeLocations.length === 0}
            className="w-full h-14 bg-primary-container text-on-primary-container rounded-2xl flex items-center justify-center gap-3 shadow-2xl active:scale-[0.97] transition-all border border-primary/20 disabled:opacity-50 disabled:grayscale"
          >
            <span className="material-symbols-outlined !text-[24px]">route</span>
            <span className="font-title-md text-base font-extrabold uppercase tracking-tight">
              {safeLocations.length === 0 ? 'Awaiting Safe Routes' : 'Find Safe Bypass'}
            </span>
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
