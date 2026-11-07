import os
import threading
from flask import Flask
import discord

# 1. Tiny Flask web server for Render
app = Flask('')

@app.route('/')
def home():
    return "Bot presence is active!"

def run_web_app():
    port = int(os.environ.get("PORT", 8080))
    app.run(host='0.0.0.0', port=port)

# 2. Discord client to keep the green light on
client = discord.Client(intents=discord.Intents.default())

@client.event
async def on_ready():
    print(f"{client.user} is now online 24/7!")
    await client.change_presence(activity=discord.Game(name="/map"))

if __name__ == "__main__":
    # Start the web server in a separate thread
    threading.Thread(target=run_web_app).start()
    
    # Run the Discord bot
    client.run(os.environ["DISCORD_TOKEN"])
