import { randomUUID } from "crypto"
import config from '../config/config.js';

function generateCreatedAt() {
  const now = new Date();
  const isoString = now.toISOString();
  const nanos = String(now.getMilliseconds()).padStart(3, '0') + '000000';
  return isoString.replace(/\.\d{3}Z$/, `.${nanos}Z`);
}


function buildRecordCodeAssistMetricsBody(token, id) {
  const traceId = randomUUID().replace(/-/g, '');
  const firstLatency = (Math.random() * 5 + 1).toFixed(9);
  const totalLatency = (Math.random() * 10 + 5).toFixed(9);
  return {
    project: token.projectId,
    requestId: randomUUID(),
    metadata: {
      ideType: "ANTIGRAVITY",
      ideVersion: config.api?.ideVersion || "2.9.1",
      platform: "WINDOWS_AMD64"
    },
    metrics: [
      {
        timestamp: generateCreatedAt(),
        conversationOffered: {
          status: "ACTION_STATUS_NO_ERROR",
          traceId: traceId,
          streamingLatency: {
            firstMessageLatency: `${firstLatency}s`,
            totalLatency: `${totalLatency}s`
          },
          isAgentic: true,
          initiationMethod: "AGENT",
          trajectoryId: id
        }
      }

    ]
  }
}
export {
  buildRecordCodeAssistMetricsBody
}
