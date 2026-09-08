-- Indexes aligned with the room list, cursor pagination, session list and
-- active-call queries. They are also applied to PostgreSQL by db:push:postgres.
CREATE INDEX IF NOT EXISTS "RoomMember_userId_favorite_joinedAt_idx" ON "RoomMember"("userId", "favorite", "joinedAt");
CREATE INDEX IF NOT EXISTS "Mensagem_roomId_id_idx" ON "Mensagem"("roomId", "id");
CREATE INDEX IF NOT EXISTS "Session_userId_lastSeenAt_idx" ON "Session"("userId", "lastSeenAt");
CREATE INDEX IF NOT EXISTS "CallHistory_roomId_endedAt_idx" ON "CallHistory"("roomId", "endedAt");
