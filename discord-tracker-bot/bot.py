import logging
import os
from datetime import datetime, timedelta
from typing import Optional

import discord
from discord.ext import commands, tasks
from dotenv import load_dotenv

import db

load_dotenv(override=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s - %(message)s",
)
logger = logging.getLogger("discord-tracker-bot")

TOKEN = (os.getenv("DISCORD_TOKEN") or "").strip()
GUILD_ID = int((os.getenv("GUILD_ID") or "0").strip())

intents = discord.Intents.default()
intents.members = True
intents.presences = True
intents.voice_states = True
intents.message_content = True

bot = commands.Bot(command_prefix="!", intents=intents)
pool = None


async def ensure_pool():
    global pool
    if pool is None:
        pool = await db.get_pool()
        await db.init_db(pool)
    return pool


def extract_game_name(member: discord.Member) -> Optional[str]:
    for activity in member.activities:
        if isinstance(activity, discord.Game) and activity.name:
            return activity.name
        if isinstance(activity, discord.Activity) and activity.type == discord.ActivityType.playing and activity.name:
            return activity.name
    return None


def fmt_minutes(minutes: float) -> str:
    total = int(minutes or 0)
    hours = total // 60
    remain = total % 60
    return f"{hours}h {remain}m" if hours else f"{remain}m"


@bot.event
async def on_ready():
    global pool
    try:
        pool = await ensure_pool()
        logger.info("Bot conectado como %s", bot.user)
        logger.info("Monitorando servidor: %s", GUILD_ID)

        if not cleanup_sessions.is_running():
            cleanup_sessions.start()

        guild = bot.get_guild(GUILD_ID)
        if guild is None:
            logger.warning("Servidor %s nao encontrado.", GUILD_ID)
            return

        for member in guild.members:
            await db.upsert_member(
                pool,
                str(member.id),
                member.name,
                member.display_name,
                str(member.display_avatar.url) if member.display_avatar else None,
            )

            if member.status != discord.Status.offline:
                await db.open_presence(pool, str(member.id), str(guild.id), str(member.status))

            if member.voice and member.voice.channel:
                await db.open_voice(pool, str(member.id), str(guild.id), str(member.voice.channel.id))

            game_name = extract_game_name(member)
            if game_name:
                await db.open_game(pool, str(member.id), str(guild.id), game_name)
    except Exception:
        logger.exception("Falha no on_ready")


@bot.event
async def on_presence_update(before: discord.Member, after: discord.Member):
    if after.guild.id != GUILD_ID:
        return
    try:
        current_pool = await ensure_pool()
        await db.upsert_member(
            current_pool,
            str(after.id),
            after.name,
            after.display_name,
            str(after.display_avatar.url) if after.display_avatar else None,
        )

        before_status = str(before.status)
        after_status = str(after.status)
        if before_status != after_status:
            if after_status == "offline":
                await db.close_presence(current_pool, str(after.id), str(after.guild.id))
            else:
                await db.open_presence(current_pool, str(after.id), str(after.guild.id), after_status)

        before_game = extract_game_name(before)
        after_game = extract_game_name(after)
        if before_game != after_game:
            if before_game:
                await db.close_game(current_pool, str(after.id), str(after.guild.id))
            if after_game:
                await db.open_game(current_pool, str(after.id), str(after.guild.id), after_game)
    except Exception:
        logger.exception("Falha no on_presence_update")


@bot.event
async def on_voice_state_update(
    member: discord.Member,
    before: discord.VoiceState,
    after: discord.VoiceState,
):
    if member.guild.id != GUILD_ID:
        return
    try:
        current_pool = await ensure_pool()
        await db.upsert_member(
            current_pool,
            str(member.id),
            member.name,
            member.display_name,
            str(member.display_avatar.url) if member.display_avatar else None,
        )

        left = before.channel is not None and (after.channel is None or before.channel.id != after.channel.id)
        joined = after.channel is not None and (before.channel is None or before.channel.id != after.channel.id)

        if left:
            await db.close_voice(current_pool, str(member.id), str(member.guild.id))
        if joined:
            await db.open_voice(current_pool, str(member.id), str(member.guild.id), str(after.channel.id))
    except Exception:
        logger.exception("Falha no on_voice_state_update")


@bot.event
async def on_member_join(member: discord.Member):
    if member.guild.id != GUILD_ID:
        return
    try:
        current_pool = await ensure_pool()
        await db.upsert_member(
            current_pool,
            str(member.id),
            member.name,
            member.display_name,
            str(member.display_avatar.url) if member.display_avatar else None,
        )
    except Exception:
        logger.exception("Falha no on_member_join")


@bot.event
async def on_message(message: discord.Message):
    if message.author.bot:
        return
    if message.guild is None or message.guild.id != GUILD_ID:
        return
    try:
        current_pool = await ensure_pool()
        await db.add_message(
            current_pool,
            str(message.author.id),
            str(message.guild.id),
            str(message.channel.id),
        )
        await db.upsert_member(
            current_pool,
            str(message.author.id),
            message.author.name,
            message.author.display_name,
            str(message.author.display_avatar.url) if message.author.display_avatar else None,
        )
    except Exception:
        logger.exception("Falha no on_message")
    finally:
        await bot.process_commands(message)


@tasks.loop(minutes=30)
async def cleanup_sessions():
    guild = bot.get_guild(GUILD_ID)
    if guild is None:
        return
    try:
        current_pool = await ensure_pool()
        async with current_pool.acquire() as conn:
            open_presence = await conn.fetch(
                """
                SELECT user_id FROM presence_sessions
                WHERE guild_id = $1 AND ended_at IS NULL
                """,
                str(GUILD_ID),
            )
            open_voice = await conn.fetch(
                """
                SELECT user_id FROM voice_sessions
                WHERE guild_id = $1 AND ended_at IS NULL
                """,
                str(GUILD_ID),
            )
            open_games = await conn.fetch(
                """
                SELECT user_id FROM game_sessions
                WHERE guild_id = $1 AND ended_at IS NULL
                """,
                str(GUILD_ID),
            )

        for row in open_presence:
            member = guild.get_member(int(row["user_id"]))
            if member is None or member.status == discord.Status.offline:
                await db.close_presence(current_pool, row["user_id"], str(GUILD_ID))

        for row in open_voice:
            member = guild.get_member(int(row["user_id"]))
            if member is None or not member.voice or not member.voice.channel:
                await db.close_voice(current_pool, row["user_id"], str(GUILD_ID))

        for row in open_games:
            member = guild.get_member(int(row["user_id"]))
            if member is None or not extract_game_name(member):
                await db.close_game(current_pool, row["user_id"], str(GUILD_ID))
    except Exception:
        logger.exception("Falha na cleanup_sessions")


@bot.command(name="stats")
async def stats(ctx: commands.Context, member: Optional[discord.Member] = None, period: str = "month"):
    target = member or ctx.author
    period_map = {"day": 1, "week": 7, "month": 30}
    days = period_map.get(period, 30)
    since = datetime.utcnow() - timedelta(days=days)

    current_pool = await ensure_pool()
    async with current_pool.acquire() as conn:
        online_min = await conn.fetchval(
            """
            SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(ended_at, NOW()) - started_at)) / 60), 0)
            FROM presence_sessions
            WHERE user_id = $1 AND guild_id = $2 AND started_at >= $3 AND status = 'online'
            """,
            str(target.id),
            str(ctx.guild.id),
            since,
        )
        voice_min = await conn.fetchval(
            """
            SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(ended_at, NOW()) - started_at)) / 60), 0)
            FROM voice_sessions
            WHERE user_id = $1 AND guild_id = $2 AND started_at >= $3
            """,
            str(target.id),
            str(ctx.guild.id),
            since,
        )
        message_count = await conn.fetchval(
            """
            SELECT COUNT(*) FROM message_events
            WHERE user_id = $1 AND guild_id = $2 AND sent_at >= $3
            """,
            str(target.id),
            str(ctx.guild.id),
            since,
        )

    embed = discord.Embed(title=f"Estatisticas de {target.display_name}", color=0x4F98A3)
    embed.add_field(name="Periodo", value=f"Ultimos {days} dias", inline=False)
    embed.add_field(name="Tempo online", value=fmt_minutes(online_min), inline=True)
    embed.add_field(name="Tempo em voz", value=fmt_minutes(voice_min), inline=True)
    embed.add_field(name="Mensagens", value=str(message_count or 0), inline=True)
    embed.set_thumbnail(url=target.display_avatar.url)
    await ctx.send(embed=embed)


@bot.command(name="ranking")
async def ranking(ctx: commands.Context, period: str = "month"):
    period_map = {"day": 1, "week": 7, "month": 30}
    days = period_map.get(period, 30)
    since = datetime.utcnow() - timedelta(days=days)

    current_pool = await ensure_pool()
    async with current_pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT p.user_id,
                   COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(p.ended_at, NOW()) - p.started_at)) / 60), 0) AS mins
            FROM presence_sessions p
            WHERE p.guild_id = $1 AND p.started_at >= $2 AND p.status = 'online'
            GROUP BY p.user_id
            ORDER BY mins DESC
            LIMIT 10
            """,
            str(ctx.guild.id),
            since,
        )

    if not rows:
        await ctx.send("Nenhum dado encontrado para este periodo.")
        return

    lines = []
    medals = ["🥇", "🥈", "🥉"]
    for idx, row in enumerate(rows):
        uid = row["user_id"]
        mins = row["mins"]
        member = ctx.guild.get_member(int(uid))
        name = member.display_name if member else f"ID:{uid}"
        marker = medals[idx] if idx < 3 else f"{idx+1}."
        lines.append(f"{marker} **{name}** - {fmt_minutes(mins)}")

    embed = discord.Embed(title=f"Ranking - Ultimos {days} dias", color=0x4F98A3)
    embed.description = "\n".join(lines)
    await ctx.send(embed=embed)


@bot.event
async def close():
    if cleanup_sessions.is_running():
        cleanup_sessions.cancel()
    if pool is not None:
        try:
            async with pool.acquire() as conn:
                await conn.execute(
                    "UPDATE presence_sessions SET ended_at = NOW() WHERE guild_id = $1 AND ended_at IS NULL",
                    str(GUILD_ID),
                )
                await conn.execute(
                    "UPDATE voice_sessions SET ended_at = NOW() WHERE guild_id = $1 AND ended_at IS NULL",
                    str(GUILD_ID),
                )
                await conn.execute(
                    "UPDATE game_sessions SET ended_at = NOW() WHERE guild_id = $1 AND ended_at IS NULL",
                    str(GUILD_ID),
                )
        finally:
            await db.close_pool()


if __name__ == "__main__":
    if not TOKEN:
        raise RuntimeError("DISCORD_TOKEN nao configurado.")
    if not GUILD_ID:
        raise RuntimeError("GUILD_ID nao configurado.")
    bot.run(TOKEN)
