import os
from typing import Optional

import asyncpg
from dotenv import load_dotenv

load_dotenv(override=True)

_pool: Optional[asyncpg.Pool] = None


async def get_pool() -> asyncpg.Pool:
    global _pool
    if _pool is None:
        database_url = os.getenv("DATABASE_URL", "").strip()
        if not database_url:
            raise RuntimeError("DATABASE_URL nao configurada.")
        _pool = await asyncpg.create_pool(database_url, min_size=2, max_size=10)
    return _pool


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


async def init_db(pool: asyncpg.Pool) -> None:
    schema = """
    CREATE TABLE IF NOT EXISTS members_cache (
        user_id TEXT PRIMARY KEY,
        username TEXT,
        display_name TEXT,
        avatar_url TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS presence_sessions (
        id BIGSERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ended_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS voice_sessions (
        id BIGSERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ended_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS message_events (
        id BIGSERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS game_sessions (
        id BIGSERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        game_name TEXT NOT NULL,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ended_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS idx_presence_user_guild ON presence_sessions(user_id, guild_id);
    CREATE INDEX IF NOT EXISTS idx_presence_started ON presence_sessions(started_at);
    CREATE INDEX IF NOT EXISTS idx_voice_user_guild ON voice_sessions(user_id, guild_id);
    CREATE INDEX IF NOT EXISTS idx_messages_user_guild ON message_events(user_id, guild_id);
    CREATE INDEX IF NOT EXISTS idx_messages_sent ON message_events(sent_at);
    CREATE INDEX IF NOT EXISTS idx_games_user_guild ON game_sessions(user_id, guild_id);
    """
    async with pool.acquire() as conn:
        await conn.execute(schema)


async def upsert_member(
    pool: asyncpg.Pool,
    user_id: str,
    username: str,
    display_name: str,
    avatar_url: Optional[str],
) -> None:
    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO members_cache (user_id, username, display_name, avatar_url, updated_at)
            VALUES ($1, $2, $3, $4, NOW())
            ON CONFLICT (user_id)
            DO UPDATE SET
                username = EXCLUDED.username,
                display_name = EXCLUDED.display_name,
                avatar_url = EXCLUDED.avatar_url,
                updated_at = NOW()
            """,
            user_id,
            username,
            display_name,
            avatar_url,
        )


async def open_presence(pool: asyncpg.Pool, user_id: str, guild_id: str, status: str) -> None:
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                """
                UPDATE presence_sessions
                SET ended_at = NOW()
                WHERE user_id = $1 AND guild_id = $2 AND ended_at IS NULL
                """,
                user_id,
                guild_id,
            )
            if status != "offline":
                await conn.execute(
                    """
                    INSERT INTO presence_sessions (user_id, guild_id, status)
                    VALUES ($1, $2, $3)
                    """,
                    user_id,
                    guild_id,
                    status,
                )


async def close_presence(pool: asyncpg.Pool, user_id: str, guild_id: str) -> None:
    async with pool.acquire() as conn:
        await conn.execute(
            """
            UPDATE presence_sessions
            SET ended_at = NOW()
            WHERE user_id = $1 AND guild_id = $2 AND ended_at IS NULL
            """,
            user_id,
            guild_id,
        )


async def open_voice(pool: asyncpg.Pool, user_id: str, guild_id: str, channel_id: str) -> None:
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                """
                UPDATE voice_sessions
                SET ended_at = NOW()
                WHERE user_id = $1 AND guild_id = $2 AND ended_at IS NULL
                """,
                user_id,
                guild_id,
            )
            await conn.execute(
                """
                INSERT INTO voice_sessions (user_id, guild_id, channel_id)
                VALUES ($1, $2, $3)
                """,
                user_id,
                guild_id,
                channel_id,
            )


async def close_voice(pool: asyncpg.Pool, user_id: str, guild_id: str) -> None:
    async with pool.acquire() as conn:
        await conn.execute(
            """
            UPDATE voice_sessions
            SET ended_at = NOW()
            WHERE user_id = $1 AND guild_id = $2 AND ended_at IS NULL
            """,
            user_id,
            guild_id,
        )


async def open_game(pool: asyncpg.Pool, user_id: str, guild_id: str, game_name: str) -> None:
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                """
                UPDATE game_sessions
                SET ended_at = NOW()
                WHERE user_id = $1 AND guild_id = $2 AND ended_at IS NULL
                """,
                user_id,
                guild_id,
            )
            await conn.execute(
                """
                INSERT INTO game_sessions (user_id, guild_id, game_name)
                VALUES ($1, $2, $3)
                """,
                user_id,
                guild_id,
                game_name,
            )


async def close_game(pool: asyncpg.Pool, user_id: str, guild_id: str) -> None:
    async with pool.acquire() as conn:
        await conn.execute(
            """
            UPDATE game_sessions
            SET ended_at = NOW()
            WHERE user_id = $1 AND guild_id = $2 AND ended_at IS NULL
            """,
            user_id,
            guild_id,
        )


async def add_message(pool: asyncpg.Pool, user_id: str, guild_id: str, channel_id: str) -> None:
    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO message_events (user_id, guild_id, channel_id)
            VALUES ($1, $2, $3)
            """,
            user_id,
            guild_id,
            channel_id,
        )
