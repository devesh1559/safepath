export interface GPSLocation {
  latitude: number;
  longitude: number;
  accuracy: number;
}

export interface MessagePart {
  text?: string;
  inlineData?: {
    mimeType: string;
    data: string;
  };
}

export interface MessageContent {
  role: 'user' | 'model';
  parts: MessagePart[];
}

export interface ChatMessage {
  id: string;
  timestamp: number;
  author: 'user' | 'agent';
  content: MessageContent;
}

export interface AgentSessionResponse {
  output: {
    id: string;
    app_name: string;
    userId: string;
    events: any[];
    lastUpdateTime: string;
  };
}

export interface AgentStreamChunk {
  id: string;
  timestamp: string;
  author: string;
  content: MessageContent;
}
