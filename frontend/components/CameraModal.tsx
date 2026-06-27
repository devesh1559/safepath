import React, { useRef, useEffect, useState } from 'react';

interface CameraModalProps {
  onCapture: (base64Image: string) => void;
  onClose: () => void;
}

export const CameraModal: React.FC<CameraModalProps> = ({ onCapture, onClose }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const startCamera = async () => {
      try {
        const mediaStream = await navigator.mediaDevices.getUserMedia({ 
          video: { facingMode: 'environment' } 
        });
        setStream(mediaStream);
        if (videoRef.current) {
          videoRef.current.srcObject = mediaStream;
        }
      } catch (err: any) {
        console.error("Error accessing camera:", err);
        setError(err?.message || "Could not access camera. Please check permissions.");
      }
    };

    startCamera();

    return () => {
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCapture = () => {
    if (videoRef.current && canvasRef.current) {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      
      const context = canvas.getContext('2d');
      if (context) {
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        // Get base64 string without the data:image/jpeg;base64, prefix for the API
        const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
        if (dataUrl && dataUrl.includes(',')) {
          const base64Data = dataUrl.split(',')[1];
          onCapture(base64Data);
        }
      }
    }
  };

  return (
    <div className="fixed inset-0 z-[100] bg-black/90 flex flex-col items-center justify-center p-4">
      <div className="relative w-full max-w-md bg-surface-container rounded-2xl overflow-hidden border border-outline-variant">
        {error ? (
          <div className="p-8 text-center text-error">
            <span className="material-symbols-outlined text-4xl mb-2">error</span>
            <p>{error}</p>
          </div>
        ) : (
          <>
            <video 
              ref={videoRef} 
              autoPlay 
              playsInline 
              className="w-full h-[60vh] object-cover bg-black"
            />
            <canvas ref={canvasRef} className="hidden" />
            
            <div className="absolute bottom-0 left-0 right-0 p-6 bg-gradient-to-t from-black/80 to-transparent flex justify-center items-center gap-8">
              <button 
                onClick={onClose}
                className="w-12 h-12 rounded-full bg-surface-variant text-on-surface flex items-center justify-center active:scale-90 transition-transform"
              >
                <span className="material-symbols-outlined">close</span>
              </button>
              
              <button 
                onClick={handleCapture}
                className="w-20 h-20 rounded-full border-4 border-primary-container flex items-center justify-center active:scale-95 transition-transform"
              >
                <div className="w-16 h-16 rounded-full bg-primary-container"></div>
              </button>
              
              <div className="w-12 h-12"></div> {/* Spacer for alignment */}
            </div>
          </>
        )}
      </div>
    </div>
  );
};
