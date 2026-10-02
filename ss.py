import logging
import os
from pathlib import Path
import requests
from telegram import Update
from telegram.ext import ApplicationBuilder, CommandHandler, ContextTypes, MessageHandler, filters

# Secrets live in .env next to this file (git-ignored); see .env.example
def load_env(path=Path(__file__).with_name(".env")):
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))

load_env()
TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
NEWS_API_KEY = os.environ.get("NEWSAPI_KEY", "")

# Set up logging
logging.basicConfig(level=logging.INFO)

# --- Helper Function ---
def fetch_news(category=None, country="in"):
    base_url = "https://newsapi.org/v2/top-headlines"
    params = {
        "country": country.lower(),
        "apiKey": NEWS_API_KEY,
        "pageSize": 5
    }
    if category:
        params["category"] = category
    response = requests.get(base_url, params=params).json()
    articles = response.get("articles", [])
    if not articles:
        return f"⚠️ No news found for country: `{country}`. Try a different one."
    msg = f"🌍 Top News for country `{country.upper()}`:\n\n"
    for article in articles:
        msg += f"📰 {article['title']}\n🔗 {article['url']}\n\n"
    return msg

# --- Telegram Commands ---
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "👋 Welcome to your Fact-Checked News Bot!\n\n"
        "🗞️ Commands:\n"
        "/topnews – India headlines\n"
        "/politics, /tech, /sports, /entertainment – Category news\n"
        "/country <code> – News by country (e.g., /country us)\n"
        "/factcheck – Trusted fact-check sources"
    )

async def top_news(update: Update, context: ContextTypes.DEFAULT_TYPE):
    msg = fetch_news()
    await update.message.reply_text(msg)

async def category_news(update: Update, context: ContextTypes.DEFAULT_TYPE):
    category = update.message.text[1:]
    msg = fetch_news(category)
    await update.message.reply_text(msg)

async def factcheck(update: Update, context: ContextTypes.DEFAULT_TYPE):
    msg = (
        "🔍 Trusted Fact-Check Sources:\n\n"
        "✅ Alt News: https://www.altnews.in\n"
        "✅ Boom Live: https://www.boomlive.in/fact-check\n"
        "✅ Factly: https://factly.in\n"
        "✅ The Logical Indian: https://thelogicalindian.com/fact-check\n\n"
        "🧠 Use these to verify claims or viral posts."
    )
    await update.message.reply_text(msg)

async def country(update: Update, context: ContextTypes.DEFAULT_TYPE):
    args = context.args
    if not args or len(args[0]) != 2:
        await update.message.reply_text("⚠️ Use format: /country <2-letter-code>\nExample: `/country in` or `/country us`")
        return
    code = args[0]
    msg = fetch_news(country=code)
    await update.message.reply_text(msg)

# --- Main Bot Setup ---
if __name__ == "__main__":
    missing = [k for k, v in (("TELEGRAM_BOT_TOKEN", TELEGRAM_BOT_TOKEN), ("NEWSAPI_KEY", NEWS_API_KEY)) if not v]
    if missing:
        raise SystemExit(f"Missing {', '.join(missing)} — add it to the .env file next to ss.py (see .env.example).")
    app = ApplicationBuilder().token(TELEGRAM_BOT_TOKEN).build()

    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("topnews", top_news))
    app.add_handler(CommandHandler("politics", category_news))
    app.add_handler(CommandHandler("tech", category_news))
    app.add_handler(CommandHandler("sports", category_news))
    app.add_handler(CommandHandler("entertainment", category_news))
    app.add_handler(CommandHandler("factcheck", factcheck))
    app.add_handler(CommandHandler("country", country))

    print("🤖 Bot is running with country filter support...")
    app.run_polling()
