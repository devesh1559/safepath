import { MessageContent } from '../types';

const AGENT_ID = 'projects/887727200141/locations/us-west1/reasoningEngines/4232864680239955968';
const LOCATION = 'us-west1';
const BASE_URL = `https://${LOCATION}-aiplatform.googleapis.com/v1/${AGENT_ID}`;

/**
 * Helper function to fetch with exponential backoff retry logic.
 * Retries on 5xx errors or network failures, but not on 4xx client errors.
 */
const fetchWithRetry = async (url: string, options: RequestInit, maxRetries = 2): Promise<Response> => {
  let retries = 0;
  while (true) {
    try {
      console.log(`[Agent Service] Fetching ${url}... (Attempt ${retries + 1})`);
      const response = await fetch(url, options);
      if (response.ok) {
        return response;
      }
      
      // Don't retry on 4xx errors (client errors)
      if (response.status >= 400 && response.status < 500) {
        let errorMsg = response.statusText;
        try {
          const errData = await response.json();
          if (errData?.error?.message) {
            errorMsg = errData.error.message;
          }
        } catch (e) {
          // Ignore JSON parse errors for error responses
        }
        throw new Error(`API Error ${response.status}: ${errorMsg}`);
      }
      
      // Retry on 5xx errors
      if (retries >= maxRetries) {
        throw new Error(`API Error ${response.status}: ${response.statusText} after ${maxRetries} retries`);
      }
    } catch (error: any) {
      // If it's a 4xx error or we've maxed out retries, throw immediately
      if (retries >= maxRetries || error?.message?.includes('API Error 4')) {
        throw error;
      }
    }
    
    retries++;
    // Faster backoff: 0.5s-1s, 1s-1.5s
    const delay = Math.pow(2, retries) * 500 + Math.random() * 500;
    console.log(`[Agent Service] Retrying request in ${Math.round(delay)}ms...`);
    await new Promise(resolve => setTimeout(resolve, delay));
  }
};

export const createAgentSession = async (userId: string): Promise<string> => {
  try {
    const response = await fetchWithRetry(`${BASE_URL}:query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Note: Assuming authentication is handled by the environment (e.g., Cloud Run proxy)
      },
      body: JSON.stringify({
        classMethod: 'async_create_session',
        input: { user_id: userId }
      })
    });

    const data = await response.json();
    if (!data?.output?.id) {
      throw new Error(`Invalid response format: ${JSON.stringify(data)}`);
    }
    return data.output.id;
  } catch (error) {
    console.error("Error creating agent session:", error);
    throw error;
  }
};

export const streamAgentQuery = async function* (
  sessionId: string,
  userId: string,
  message: MessageContent | string
) {
  try {
    const response = await fetchWithRetry(`${BASE_URL}:streamQuery`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        classMethod: 'async_stream_query',
        input: {
          user_id: userId,
          session_id: sessionId,
          message: message
        }
      })
    });

    if (!response.body) {
      throw new Error("Response body is null");
    }

    const decoder = new TextDecoder();
    let buffer = '';
    
    for await (const chunk of response.body as any) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      
      // Keep the last incomplete line in the buffer
      buffer = lines.pop() || '';
      
      for (const line of lines) {
        if (line.trim() === '') continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed?.error) {
            throw new Error(parsed.error.message || "Stream returned an error");
          }
          yield parsed;
        } catch (e: any) {
          if (e?.message && (e.message.includes("Stream returned an error") || e.message.includes("API Error"))) {
            throw e;
          }
          console.warn("Failed to parse chunk line as JSON:", line);
        }
      }
    }
    
    // Process any remaining buffer
    if (buffer.trim() !== '') {
      try {
        const parsed = JSON.parse(buffer);
        if (parsed?.error) {
          throw new Error(parsed.error.message || "Stream returned an error");
        }
        yield parsed;
      } catch (e) {
        console.warn("Failed to parse final chunk line as JSON:", buffer);
      }
    }
  } catch (error) {
    console.error("Error streaming agent query:", error);
    throw error;
  }
};
