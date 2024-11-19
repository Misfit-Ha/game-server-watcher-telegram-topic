import {Bot} from 'grammy'
import {JSONPreset} from 'lowdb/node'
import {GameServer} from './game-server.js'
import hhmmss from './lib/hhmmss.js'
import {TelegramConfig} from './watcher.js'

const DATA_PATH = process.env.DATA_PATH || './data/'
const DBG = Boolean(Number(process.env.DBG))

interface TelegramData {
    chatId: string
    host: string
    port: number
    messageId: number
}

const db = await JSONPreset<TelegramData[]>(DATA_PATH + 'telegram.json', [])

const serverInfoMessages: ServerInfoMessage[] = []

let bot: Bot
export async function init(token: string) {
    if (!bot) {
        console.log('telegram-bot starting...')
        try {
            bot = new Bot(token)

            bot.catch((e) => {
                console.error('telegram-bot ERROR', e.message || e)
            })

            const me = await bot.api.getMe()
            console.log('telegram-bot ready', me)

            if (DBG) {
                bot.on('message:text', (ctx) => {
                    if (ctx.message.text === 'ping') ctx.reply('pong')
                })
                // bot.command('ping', ctx => ctx.reply('/pong'));
                bot.start()
            }
        } catch (e: any) {
            console.error('telegram-bot init ERROR', e.message || e)
        }
    }

    serverInfoMessages.length = 0
    await db.read()
}

async function getServerInfoMessage(cid: string, host: string, port: number) {
    let m = serverInfoMessages.find((n) => {
        return n.chatId === cid && n.host === host && n.port === port
    })

    if (!m) {
        m = new ServerInfoMessage(cid, host, port)

        let msgId
        if (db.data) {
            const md = db.data.find((d) => {
                return d.chatId === cid && d.host === host && d.port === port
            })
            if (md) msgId = md.messageId
        }

        await m.init(msgId)

        serverInfoMessages.push(m)
    }

    return m
}

export async function serverUpdate(gs: GameServer) {
    if (DBG)
        console.log(
            'telegram.serverUpdate',
            gs.config.host,
            gs.config.port,
            gs.config.telegram
        )

    if (gs.config.telegram) {
        for (const conf of gs.config.telegram) {
            try {
                let m = await getServerInfoMessage(
                    conf.chatId,
                    gs.config.host,
                    gs.config.port
                )
                await m.updatePost(gs, conf)
            } catch (e: any) {
                console.error(
                    [
                        'telegram-bot.sup',
                        conf.chatId,
                        gs.config.host,
                        gs.config.port,
                    ].join(':'),
                    e.message || e
                )
            }
        }
    }
}

class ServerInfoMessage {
    public chatId: string
    public host: string
    public port: number
    public messageId: number = 0

    constructor(chatId: string, host: string, port: number) {
        this.chatId = chatId
        this.host = host
        this.port = port
    }

    async init(msgId?: number) {
        if (msgId) this.messageId = msgId
        else {
            const {chatId, messageThreadId} = this.extractChatIdAndThreadId(
                this.chatId
            )
            const options: any = {parse_mode: 'Markdown'}
            if (messageThreadId !== undefined) {
                options.message_thread_id = messageThreadId
            }
            const msg = await bot.api.sendMessage(
                chatId,
                'Initializing server info...',
                options
            )
            this.messageId = msg.message_id
        }

        if (db.data && this.messageId) {
            const mi = db.data.findIndex((d) => {
                return (
                    d.chatId === this.chatId &&
                    d.host === this.host &&
                    d.port === this.port
                )
            })

            if (mi === -1 || mi === undefined) {
                db.data.push({
                    chatId: this.chatId,
                    host: this.host,
                    port: this.port,
                    messageId: this.messageId,
                })
            } else db.data[mi].messageId = this.messageId

            try {
                await db.write()
            } catch (e: any) {
                console.error(
                    [
                        'telegram.init.db',
                        this.chatId,
                        this.host,
                        this.port,
                    ].join(':'),
                    e.message || e
                )
            }
        }
    }

    async updatePost(gs: GameServer, conf: TelegramConfig) {
        const showPlayersList = Boolean(conf.showPlayersList)
        const showGraph = Boolean(conf.showGraph)
    
        const chart = showGraph ? '[📈](' + gs.history.statsChart() + ')' : ''
        let infoText = `*${this.escapeMarkdown(gs.niceName)}* 🔴 Offline\\.\\.\\.\n\n`

        if (gs.info && gs.online) {
          infoText = [
            `🖥 *${this.escapeMarkdown(gs.config.name)}*\n`,
            `📡 *${this.escapeMarkdown(gs.niceName)}*\n`,
            `🎮 *${this.escapeMarkdown(gs.info.game)}*` +
              (gs.info.map != ''
                ? ` / 🗺 _${this.escapeMarkdown(gs.info.map)}_`
                : '') +
              '\n',
            `🌐 \`${this.escapeMarkdown(gs.info.connect)}\`\n`,
            `👥 Players: *${gs.info.playersNum}/${gs.info.playersMax}*\n`,
          ].join('\n')
    
          if (gs.config.infoText)
            infoText +=
              '\n📌 *Info:*\n' + 
              this.escapeMarkdown(String(gs.config.infoText).slice(0, 1024)) + 
              '\n\n'
    
          if (showPlayersList && gs.info.players.length > 0) {
            const pnArr: string[] = []
            for (const p of gs.info.players) {
              let playerLine = ''
              if (p.get('time') !== undefined)
                playerLine += '⏱ ' + hhmmss(p.get('time') || '0') + ' '
              if (p.get('name') !== undefined)
                playerLine += '👤 ' + this.escapeMarkdown(p.get('name') || 'n/a')
              if (p.get('score') !== undefined)
                playerLine += ' 🏆 ' + (p.get('score') || 0)
              pnArr.push(playerLine)
            }
    
            if (pnArr.length > 0) {
              infoText +=
                '*Player List:*\n```\n' +
                pnArr
                  .join('\n')
                  .slice(0, 4088 - infoText.length - chart.length) +
                '\n```\n\n'
            }
          }
        }
    
        infoText += chart
    
        // Add the last updated date and time in Iran timezone
        const now = new Date()
        const iranTime = new Intl.DateTimeFormat('en-US', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
          timeZone: 'Asia/Tehran'
        }).format(now)
    
        infoText += `\n🕒 *Last updated:* _${iranTime}_`
    
        try {
          const {chatId} = this.extractChatIdAndThreadId(this.chatId)
          await bot.api.editMessageText(chatId, this.messageId, infoText, {
            parse_mode: 'MarkdownV2',
          })
        } catch (e: any) {
          console.error(
            ['telegram.up', this.chatId, this.host, this.port].join(':'),
            e.message || e
          )
        }
      }
      
    extractChatIdAndThreadId(chatId: string) {
        const parts = chatId.split('_')
        return {
            chatId: parts[0],
            messageThreadId: parts[1] ? parseInt(parts[1], 10) : undefined,
        }
    }

    escapeMarkdown(str: string): string {
        const specialChars = ['_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!'];
        
        let escapedStr = str;
        for (const char of specialChars) {
          escapedStr = escapedStr.replace(new RegExp('\\' + char, 'g'), '\\' + char);
        }
        
        return escapedStr;
    }
}
