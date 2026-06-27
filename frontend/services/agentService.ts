import { MessageContent } from '../types';

const AGENT_ID = 'projects/887727200141/locations/us-west1/reasoningEngines/4232864680239955968';
const LOCATION = 'us-west1';
const BASE_URL = `https://${LOCATION}-aiplatform.googleapis.com/v1/${AGENT_ID}`;

/**
 * Helper function to fetch with exponential backoff retry logic.
 * Retries on 5xx errors or network failures, but not on 4xx client errors.
 */
const fetchWithRetry = async (url: string, options: RequestInit, maxRetries = 3): Promise<Response> => {
  let retries = 0;
  while (true) {
    try {
      const response = await fetch(url, options);
      if (response.ok) {
        return response;
      }
      
      // Don't retry on 4xx errors (client errors)
      if (response.status >= 400 && response.status < 500) {
        let errorMsg = response.statusText;
        try {
          const errData = await response.json();
          if (errData && errData.error && errData.error.message) {
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
      if (retries >= maxRetries || (error.message && error.message.includes('API Error 4'))) {
        throw error;
      }
    }
    
    retries++;
    // Exponential backoff: 2s, 4s, 8s + random jitter
    const delay = Math.pow(2, retries) * 1000 + Math.random() * 1000;
    console.log(`[Agent Service] Retrying request in ${Math.round(delay)}ms... (Attempt ${retries}/${maxRetries})`);
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
    if (!data || !data.output || !data.output.id) {
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
    for await (const chunk of response.body as any) {
      const chunkText = decoder.decode(chunk, { stream: true });
      // The stream might contain multiple JSON objects separated by newlines
      const lines = chunkText.split('\n').filter(line => line.trim() !== '');
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed && parsed.error) {
            throw new Error(parsed.error.message || "Stream returned an error");
          }
          yield parsed;
        } catch (e: any) {
          if (e.message && e.message.includes("Stream returned an error")) {
            throw e;
          }
          console.warn("Failed to parse chunk line as JSON:", line);
        }
      }
    }
  } catch (error) {
    console.error("Error streaming agent query:", error);
    throw error;
  }
};
