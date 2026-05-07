import os
from datetime import datetime, timedelta
from typing import Literal

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

import db

load_dotenv(override=True)

app = FastAPI(title="Discord Tracker API")
app.mount("/static", StaticFiles(directory="static"), name="static")


def period_since(period: Literal["day", "week", "month"]) -> datetime:
    days_map = {"day": 1, "week": 7, "month": 30}
    return datetime.utcnow() - timedelta(days=days_map.get(period, 30))


@app.on_event("startup")
async def startup() -> None:
    pool = await db.get_pool()
    await db.init_db(pool)
    app.state.pool = pool


@app.on_event("shutdown")
async def shutdown() -> None:
    await db.close_pool()


@app.get("/")
async def root():
    return FileResponse("static/index.html")


def check_secret(secret: str | None) -> None:
    api_secret = (os.getenv("API_SECRET") or "").strip()
    if api_secret and secret != api_secret:
        raise HTTPException(status_code=401, detail="Unauthorized")


def resolve_guild_id(guild_id: str | None) -> str:
    value = (guild_id or "").strip() or (os.getenv("GUILD_ID") or "").strip()
    if not value:
        raise HTTPException(status_code=400, detail="guild_id is required")
    return value


@app.get("/api/config")
async def config():
    default_guild_id = (os.getenv("GUILD_ID") or "").strip()
    api_secret = (os.getenv("API_SECRET") or "").strip()
    return {
        "default_guild_id": default_guild_id,
        "secret_required": bool(api_secret),
    }


@app.get("/api/overview")
async def overview(
    period: Literal["day", "week", "month"] = Query("month"),
    guild_id: str | None = Query(None),
    secret: str | None = Query(None),
):
    check_secret(secret)
    guild_id = resolve_guild_id(guild_id)
    since = period_since(period)
    pool = app.state.pool
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT
                COUNT(DISTINCT user_id) FILTER (WHERE status = 'online') AS active_members,
                COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(ended_at, NOW()) - started_at))/60)
                    FILTER (WHERE status = 'online'), 0) AS total_online_minutes
            FROM presence_sessions
            WHERE guild_id = $1 AND started_at >= $2
            """,
            guild_id,
            since,
        )
        voice_total = await conn.fetchval(
            """
            SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(ended_at, NOW()) - started_at))/60), 0)
            FROM voice_sessions
            WHERE guild_id = $1 AND started_at >= $2
            """,
            guild_id,
            since,
        )
        msg_total = await conn.fetchval(
            """
            SELECT COUNT(*) FROM message_events
            WHERE guild_id = $1 AND sent_at >= $2
            """,
            guild_id,
            since,
        )
        game_total = await conn.fetchval(
            """
            SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(ended_at, NOW()) - started_at))/60), 0)
            FROM game_sessions
            WHERE guild_id = $1 AND started_at >= $2
            """,
            guild_id,
            since,
        )
    return {
        "active_members": row["active_members"] or 0,
        "total_online_minutes": round(row["total_online_minutes"] or 0),
        "total_voice_minutes": round(voice_total or 0),
        "total_messages": int(msg_total or 0),
        "total_game_minutes": round(game_total or 0),
        "period": period,
    }


@app.get("/api/top/online")
async def top_online(
    period: Literal["day", "week", "month"] = Query("month"),
    guild_id: str | None = Query(None),
    secret: str | None = Query(None),
):
    check_secret(secret)
    guild_id = resolve_guild_id(guild_id)
    since = period_since(period)
    pool = app.state.pool
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT
                mc.user_id,
                mc.display_name,
                mc.avatar_url,
                COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(ps.ended_at, NOW()) - ps.started_at))/60), 0) AS online_minutes,
                COALESCE((
                    SELECT SUM(EXTRACT(EPOCH FROM (COALESCE(vs.ended_at, NOW()) - vs.started_at))/60)
                    FROM voice_sessions vs
                    WHERE vs.user_id = mc.user_id AND vs.guild_id = $1 AND vs.started_at >= $2
                ), 0) AS voice_minutes
            FROM members_cache mc
            JOIN presence_sessions ps ON ps.user_id = mc.user_id
            WHERE ps.guild_id = $1 AND ps.started_at >= $2 AND ps.status = 'online'
            GROUP BY mc.user_id, mc.display_name, mc.avatar_url
            ORDER BY online_minutes DESC
            LIMIT 10
            """,
            guild_id,
            since,
        )
    data = []
    for idx, row in enumerate(rows, start=1):
        data.append(
            {
                "rank": idx,
                "user_id": row["user_id"],
                "display_name": row["display_name"],
                "avatar_url": row["avatar_url"],
                "online_minutes": round(row["online_minutes"] or 0),
                "voice_minutes": round(row["voice_minutes"] or 0),
            }
        )
    return {"data": data}


@app.get("/api/top/messages")
async def top_messages(
    period: Literal["day", "week", "month"] = Query("month"),
    guild_id: str | None = Query(None),
    secret: str | None = Query(None),
):
    check_secret(secret)
    guild_id = resolve_guild_id(guild_id)
    since = period_since(period)
    pool = app.state.pool
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT
                mc.user_id,
                mc.display_name,
                mc.avatar_url,
                COUNT(me.id) AS message_count,
                COUNT(DISTINCT me.channel_id) AS distinct_channels
            FROM members_cache mc
            JOIN message_events me ON me.user_id = mc.user_id
            WHERE me.guild_id = $1 AND me.sent_at >= $2
            GROUP BY mc.user_id, mc.display_name, mc.avatar_url
            ORDER BY message_count DESC
            LIMIT 10
            """,
            guild_id,
            since,
        )
    return {
        "data": [
            {
                "rank": idx,
                "user_id": row["user_id"],
                "display_name": row["display_name"],
                "avatar_url": row["avatar_url"],
                "message_count": int(row["message_count"] or 0),
                "distinct_channels": int(row["distinct_channels"] or 0),
            }
            for idx, row in enumerate(rows, start=1)
        ]
    }


@app.get("/api/top/games")
async def top_games(
    period: Literal["day", "week", "month"] = Query("month"),
    guild_id: str | None = Query(None),
    secret: str | None = Query(None),
):
    check_secret(secret)
    guild_id = resolve_guild_id(guild_id)
    since = period_since(period)
    pool = app.state.pool
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            WITH game_minutes AS (
                SELECT
                    user_id,
                    game_name,
                    SUM(EXTRACT(EPOCH FROM (COALESCE(ended_at, NOW()) - started_at))/60) AS minutes
                FROM game_sessions
                WHERE guild_id = $1 AND started_at >= $2
                GROUP BY user_id, game_name
            ),
            top_game AS (
                SELECT DISTINCT ON (user_id) user_id, game_name, minutes
                FROM game_minutes
                ORDER BY user_id, minutes DESC
            ),
            totals AS (
                SELECT user_id, SUM(minutes) AS total_minutes
                FROM game_minutes
                GROUP BY user_id
            )
            SELECT
                mc.user_id,
                mc.display_name,
                mc.avatar_url,
                tg.game_name AS top_game,
                t.total_minutes AS game_minutes
            FROM totals t
            JOIN members_cache mc ON mc.user_id = t.user_id
            LEFT JOIN top_game tg ON tg.user_id = t.user_id
            ORDER BY t.total_minutes DESC
            LIMIT 10
            """,
            guild_id,
            since,
        )
    return {
        "data": [
            {
                "rank": idx,
                "user_id": row["user_id"],
                "display_name": row["display_name"],
                "avatar_url": row["avatar_url"],
                "top_game": row["top_game"],
                "game_minutes": round(row["game_minutes"] or 0),
            }
            for idx, row in enumerate(rows, start=1)
        ]
    }


@app.get("/api/top/voice")
async def top_voice(
    period: Literal["day", "week", "month"] = Query("month"),
    guild_id: str | None = Query(None),
    secret: str | None = Query(None),
):
    check_secret(secret)
    guild_id = resolve_guild_id(guild_id)
    since = period_since(period)
    pool = app.state.pool
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT
                mc.user_id,
                mc.display_name,
                mc.avatar_url,
                COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(vs.ended_at, NOW()) - vs.started_at))/60), 0) AS voice_minutes
            FROM members_cache mc
            JOIN voice_sessions vs ON vs.user_id = mc.user_id
            WHERE vs.guild_id = $1 AND vs.started_at >= $2
            GROUP BY mc.user_id, mc.display_name, mc.avatar_url
            ORDER BY voice_minutes DESC
            LIMIT 10
            """,
            guild_id,
            since,
        )
    return {
        "data": [
            {
                "rank": idx,
                "user_id": row["user_id"],
                "display_name": row["display_name"],
                "avatar_url": row["avatar_url"],
                "voice_minutes": round(row["voice_minutes"] or 0),
            }
            for idx, row in enumerate(rows, start=1)
        ]
    }


@app.get("/api/games/ranking")
async def games_ranking(
    period: Literal["day", "week", "month"] = Query("month"),
    guild_id: str | None = Query(None),
    secret: str | None = Query(None),
):
    check_secret(secret)
    guild_id = resolve_guild_id(guild_id)
    since = period_since(period)
    pool = app.state.pool
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT
                game_name,
                COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(ended_at, NOW()) - started_at))/60), 0) AS total_minutes,
                COUNT(DISTINCT user_id) AS unique_players
            FROM game_sessions
            WHERE guild_id = $1 AND started_at >= $2
            GROUP BY game_name
            ORDER BY total_minutes DESC
            LIMIT 10
            """,
            guild_id,
            since,
        )
    return {
        "data": [
            {
                "rank": idx,
                "game_name": row["game_name"],
                "total_minutes": round(row["total_minutes"] or 0),
                "unique_players": int(row["unique_players"] or 0),
            }
            for idx, row in enumerate(rows, start=1)
        ]
    }


@app.get("/api/timeline")
async def timeline(
    period: Literal["day", "week", "month"] = Query("month"),
    guild_id: str | None = Query(None),
    secret: str | None = Query(None),
):
    check_secret(secret)
    guild_id = resolve_guild_id(guild_id)
    since = period_since(period)
    pool = app.state.pool
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            WITH presence_by_day AS (
                SELECT
                    DATE(started_at) AS day,
                    COUNT(DISTINCT user_id) AS members_online,
                    COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(ended_at, NOW()) - started_at))/60), 0) AS total_online_minutes
                FROM presence_sessions
                WHERE guild_id = $1 AND started_at >= $2 AND status = 'online'
                GROUP BY DATE(started_at)
            ),
            message_by_day AS (
                SELECT DATE(sent_at) AS day, COUNT(*) AS total_messages
                FROM message_events
                WHERE guild_id = $1 AND sent_at >= $2
                GROUP BY DATE(sent_at)
            ),
            voice_by_day AS (
                SELECT
                    DATE(started_at) AS day,
                    COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(ended_at, NOW()) - started_at))/60), 0) AS total_voice_minutes
                FROM voice_sessions
                WHERE guild_id = $1 AND started_at >= $2
                GROUP BY DATE(started_at)
            )
            SELECT
                p.day,
                p.members_online,
                p.total_online_minutes,
                COALESCE(m.total_messages, 0) AS total_messages,
                COALESCE(v.total_voice_minutes, 0) AS total_voice_minutes
            FROM presence_by_day p
            LEFT JOIN message_by_day m ON m.day = p.day
            LEFT JOIN voice_by_day v ON v.day = p.day
            ORDER BY p.day
            """,
            guild_id,
            since,
        )
    return {
        "data": [
            {
                "date": row["day"].isoformat(),
                "members_online": int(row["members_online"] or 0),
                "total_online_minutes": round(row["total_online_minutes"] or 0),
                "total_messages": int(row["total_messages"] or 0),
                "total_voice_minutes": round(row["total_voice_minutes"] or 0),
            }
            for row in rows
        ],
        "period": period,
    }


@app.get("/api/members")
async def members(
    period: Literal["day", "week", "month"] = Query("month"),
    guild_id: str | None = Query(None),
    secret: str | None = Query(None),
):
    check_secret(secret)
    guild_id = resolve_guild_id(guild_id)
    since = period_since(period)
    pool = app.state.pool
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            WITH p AS (
                SELECT
                    user_id,
                    COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(ended_at, NOW()) - started_at))/60), 0) AS online_minutes,
                    MAX(started_at) AS last_seen
                FROM presence_sessions
                WHERE guild_id = $1 AND started_at >= $2 AND status = 'online'
                GROUP BY user_id
            ),
            v AS (
                SELECT
                    user_id,
                    COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(ended_at, NOW()) - started_at))/60), 0) AS voice_minutes
                FROM voice_sessions
                WHERE guild_id = $1 AND started_at >= $2
                GROUP BY user_id
            ),
            m AS (
                SELECT user_id, COUNT(*) AS message_count
                FROM message_events
                WHERE guild_id = $1 AND sent_at >= $2
                GROUP BY user_id
            ),
            g AS (
                SELECT
                    user_id,
                    COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(ended_at, NOW()) - started_at))/60), 0) AS game_minutes
                FROM game_sessions
                WHERE guild_id = $1 AND started_at >= $2
                GROUP BY user_id
            ),
            tg AS (
                SELECT DISTINCT ON (user_id)
                    user_id,
                    game_name,
                    SUM(EXTRACT(EPOCH FROM (COALESCE(ended_at, NOW()) - started_at))/60) AS top_game_minutes
                FROM game_sessions
                WHERE guild_id = $1 AND started_at >= $2
                GROUP BY user_id, game_name
                ORDER BY user_id, top_game_minutes DESC
            )
            SELECT
                mc.user_id,
                mc.display_name,
                mc.avatar_url,
                COALESCE(p.online_minutes, 0) AS online_minutes,
                COALESCE(v.voice_minutes, 0) AS voice_minutes,
                COALESCE(m.message_count, 0) AS message_count,
                COALESCE(g.game_minutes, 0) AS game_minutes,
                tg.game_name AS top_game,
                p.last_seen
            FROM members_cache mc
            LEFT JOIN p ON p.user_id = mc.user_id
            LEFT JOIN v ON v.user_id = mc.user_id
            LEFT JOIN m ON m.user_id = mc.user_id
            LEFT JOIN g ON g.user_id = mc.user_id
            LEFT JOIN tg ON tg.user_id = mc.user_id
            ORDER BY online_minutes DESC
            """,
            guild_id,
            since,
        )
    data = [
        {
            "user_id": row["user_id"],
            "display_name": row["display_name"],
            "avatar_url": row["avatar_url"],
            "online_minutes": round(row["online_minutes"] or 0),
            "voice_minutes": round(row["voice_minutes"] or 0),
            "message_count": int(row["message_count"] or 0),
            "game_minutes": round(row["game_minutes"] or 0),
            "top_game": row["top_game"],
            "last_seen": row["last_seen"].isoformat() if row["last_seen"] else None,
        }
        for row in rows
    ]
    return {"data": data, "total": len(data), "period": period}


if __name__ == "__main__":
    import uvicorn

    port = int((os.getenv("PORT") or "8000").strip())
    uvicorn.run(app, host="0.0.0.0", port=port)
