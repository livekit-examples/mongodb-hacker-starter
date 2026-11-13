// Entry point for the LiveKit + MongoDB voice agent.
//
// Mirrors the upstream `agent-starter-node` template scaffold and layers the
// five MongoDB integration patterns from `code/agent/src/agent.py:346-412` on
// top: dispatch metadata -> preload -> session -> shutdown report -> greet.
import {
  type JobContext,
  ServerOptions,
  cli,
  defineAgent,
  inference,
  voice,
} from '@livekit/agents';
import { audioEnhancement } from '@livekit/plugins-ai-coustics';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { MongoAgent } from './agent';
import { closeMongoClient, getDb } from './db/client';
import { preloadUser } from './preload';

dotenv.config({ path: '.env.local' });

const DEFAULT_USER_ID = 'user_1';
const DEFAULT_TENANT_ID = 'default';

interface DispatchMetadata {
  user_id?: string;
  tenant_id?: string;
}

function safeParseMetadata(raw: string | undefined | null): DispatchMetadata {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as DispatchMetadata;
  } catch {
    console.warn('ctx.job.metadata was not valid JSON; using defaults');
  }
  return {};
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    // Pattern 3 setup: identify the user from agent dispatch metadata so the
    // preload Mongo lookup runs in parallel with the room connection.
    const meta = safeParseMetadata(ctx.job.metadata);
    const userId = meta.user_id ?? DEFAULT_USER_ID;
    const tenantId = meta.tenant_id ?? DEFAULT_TENANT_ID;
    ctx.proc.userData.user_id = userId;
    ctx.proc.userData.tenant_id = tenantId;

    const initialChatCtx = await preloadUser(userId, tenantId);

    const session = new voice.AgentSession({
      stt: new inference.STT({
        model: 'deepgram/nova-3',
        language: 'multi',
      }),
      llm: new inference.LLM({
        model: 'openai/gpt-5.3-chat-latest',
      }),
      tts: new inference.TTS({
        model: 'cartesia/sonic-3',
        voice: '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc',
      }),
      turnHandling: {
        // LiveKit's audio turn detector: predicts end of turn from the user's
        // audio (semantics plus intonation and pacing). It's built into the SDK
        // and AgentSession supplies the VAD it needs automatically.
        // See https://docs.livekit.io/agents/logic/turns/turn-detector/
        turnDetection: new inference.TurnDetector(),
        // Let the LLM start generating while waiting for the end of turn.
        preemptiveGeneration: { enabled: true },
      },
    });

    // Pattern 5: persist a session report to MongoDB on hangup.
    ctx.addShutdownCallback(async () => {
      try {
        const report = ctx.makeSessionReport(session);
        const db = await getDb();
        await db.collection('sessions').insertOne({
          session_id: ctx.room.name,
          user_id: ctx.proc.userData.user_id,
          tenant_id: ctx.proc.userData.tenant_id,
          room_name: ctx.room.name,
          report: voice.sessionReportToJSON(report),
        });
        console.info(`Persisted session report for ${ctx.room.name}`);
      } catch (err) {
        console.error('Failed to persist session report', err);
      } finally {
        await closeMongoClient();
      }
    });

    await session.start({
      agent: new MongoAgent({
        chatCtx: initialChatCtx,
        userId,
        tenantId,
      }),
      room: ctx.room,
      inputOptions: {
        noiseCancellation: audioEnhancement({ model: 'quailVfL' }),
      },
    });

    await ctx.connect();

    session.generateReply({
      instructions:
        'Greet the user by name if the loaded profile or remembered ' +
        'facts contain one. If no name is on file, briefly introduce ' +
        'yourself as a MongoDB-backed voice assistant and ask the ' +
        'user for their name. When they tell you, call update_profile ' +
        "with field='name' so it persists for next time.",
    });
  },
});

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: 'my-agent',
  }),
);
