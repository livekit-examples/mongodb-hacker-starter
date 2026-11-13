import { NextRequest, NextResponse } from 'next/server';
import {
  AccessToken,
  type AccessTokenOptions,
  RoomAgentDispatch,
  RoomConfiguration,
  type VideoGrant,
} from 'livekit-server-sdk';

type ConnectionDetails = {
  serverUrl: string;
  roomName: string;
  participantName: string;
  participantToken: string;
};

// NOTE: you are expected to define the following environment variables in `.env.local`:
const API_KEY = process.env.LIVEKIT_API_KEY;
const API_SECRET = process.env.LIVEKIT_API_SECRET;
const LIVEKIT_URL = process.env.LIVEKIT_URL;
const AGENT_NAME = process.env.AGENT_NAME;

// Anonymous identity cookie. In production, replace the cookie read below with
// a real session lookup (NextAuth, Clerk, Supabase, etc.) and fall through to
// the anonymous cookie only for guest users.
const COOKIE_NAME = 'lk_mongo_user_cookie';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

const DEFAULT_TENANT_ID = 'default';

// don't cache the results
export const revalidate = 0;

export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV !== 'development') {
    throw new Error(
      'THIS API ROUTE IS INSECURE. DO NOT USE THIS ROUTE IN PRODUCTION WITHOUT AN AUTHENTICATION LAYER.'
    );
  }

  try {
    if (LIVEKIT_URL === undefined) {
      throw new Error('LIVEKIT_URL is not defined');
    }
    if (API_KEY === undefined) {
      throw new Error('LIVEKIT_API_KEY is not defined');
    }
    if (API_SECRET === undefined) {
      throw new Error('LIVEKIT_API_SECRET is not defined');
    }

    // Resolve the user id server-side. The cookie is httpOnly so JavaScript on
    // the page cannot read or forge it. We mint one on first visit and set it
    // on the response below.
    let userId = req.cookies.get(COOKIE_NAME)?.value;
    const isNewCookie = !userId;
    if (!userId) {
      userId = crypto.randomUUID();
    }

    // Stamp the verified user id onto the agent dispatch entry. The metadata
    // string lands in ctx.job.metadata on the agent before ctx.connect(), which
    // is where preload_user reads it. We build roomConfig here rather than
    // trust body.room_config so the server is the sole authority for identity.
    const metadata = JSON.stringify({ user_id: userId, tenant_id: DEFAULT_TENANT_ID });
    const roomConfig = AGENT_NAME
      ? new RoomConfiguration({
          agents: [new RoomAgentDispatch({ agentName: AGENT_NAME, metadata })],
        })
      : new RoomConfiguration();

    // Generate participant token
    const participantName = 'user';
    const participantIdentity = `voice_assistant_user_${Math.floor(Math.random() * 10_000)}`;
    const roomName = `voice_assistant_room_${Math.floor(Math.random() * 10_000)}`;

    const participantToken = await createParticipantToken(
      { identity: participantIdentity, name: participantName },
      roomName,
      roomConfig
    );

    const data: ConnectionDetails = {
      serverUrl: LIVEKIT_URL,
      roomName,
      participantName,
      participantToken,
    };
    const res = NextResponse.json(data);
    res.headers.set('Cache-Control', 'no-store');
    if (isNewCookie) {
      res.cookies.set({
        name: COOKIE_NAME,
        value: userId,
        httpOnly: true,
        sameSite: 'lax',
        secure: IS_PRODUCTION,
        path: '/',
        maxAge: COOKIE_MAX_AGE,
      });
    }
    return res;
  } catch (error) {
    if (error instanceof Error) {
      console.error(error);
      return new NextResponse(error.message, { status: 500 });
    }
  }
}

function createParticipantToken(
  userInfo: AccessTokenOptions,
  roomName: string,
  roomConfig: RoomConfiguration | undefined
): Promise<string> {
  const at = new AccessToken(API_KEY, API_SECRET, {
    ...userInfo,
    ttl: '15m',
  });
  const grant: VideoGrant = {
    room: roomName,
    roomJoin: true,
    canPublish: true,
    canPublishData: true,
    canSubscribe: true,
  };
  at.addGrant(grant);

  if (roomConfig) {
    at.roomConfig = roomConfig;
  }

  return at.toJwt();
}
