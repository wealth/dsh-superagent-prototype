# 008 Поваренная книга

Эта поваренная книга показывает, как расширять dsh-superagent. Она использует термины из [001 Domain model](001-domain.md) и [002 Authorization](002-authorization.md) и компоненты из [007 Architecture](007-architecture.md).

## Добавить Источник

Этот рецепт реализует вид Источника под названием `webhook`. Он читает воображаемую очередь сообщений через выдуманный CLI, `hookq`, и преобразует сообщения в Триггеры. Все остальные интерфейсы — часть dsh-superagent.

У реализации четыре обязанности: переводить события, определять правила приёма и авторизации, предоставлять ответы и контекст, и поддерживать цикл опроса. Пронумерованные шаги строят эти части по порядку.

Пример предполагает такой контракт CLI:

- `hookq pull --after <n> --json` печатает сообщения после позиции `n`, начиная со старейших: `{"me": "<the agent's id on the queue>", "items": […], "next": <position>}`. У элемента есть `id`, `conversation`, `thread` (id сообщения, начавшего его тред, отсутствующий на этом сообщении), `sender` с `id` и `bot`, `mentions_me`, `text`, `at` и `url`.
- `hookq reply --conversation <id> --to <message id> --key <key> --text <text>` отвечает под сообщением, один раз на ключ. Для удалённой беседы он завершается с `{"error": {"code": 410, "message": "…"}}` в стандартный вывод ошибок.
- `hookq thread --conversation <id> --root <message id> --json`, с `--after <cursor>` для более поздней страницы, печатает страницу треда, начиная со старейших: `{"items": […], "next": "<cursor>"}`, без `next` на последней странице.

Поместите вид и его точку входа плагина в `src/sources/webhook.ts`, следуя `src/sources/github.ts`. Если Источник растёт, разделите код трансляции, Канала и опроса на отдельные модули, как это делает Источник Feishu.

### 1. Сопоставьте события с предметной областью

Выберите стабильные сопоставления до написания кода. Id Триггеров, id Тредов и адреса Каналов сохраняются на диск, поэтому их изменение позже может разорвать существующие записи.

| Понятие | Для очереди webhook |
| --- | --- |
| Триггер | Одно сообщение |
| Тред | Сообщение и ответы на него в одной беседе: `<conversation>:<id of the first message>` |
| Действующее лицо | Id отправителя в очереди, как его называет список разрешённых |
| Адрес Канала | Беседа и сообщение, под которым идёт ответ |
| Область приёма | Беседа, со своей строкой в таблице приёма |

### 2. Конфигурация: schema, fields, facts и health

Модуль импортирует то, что используют шаги ниже:

```ts
import type { Context } from '@deepseek-ai/cordis'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { key, threadKey, type OutboundMessage, type Trigger } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import { KV } from '../kv.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'
```

```ts
const ConfigSchema = z.object({
  conversations: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    listen: z.enum(['mentions', 'all']),
  }).strict()).default([]),
  pollSeconds: z.number().int().min(10).max(3600).default(30),
}).strict()
export type WebhookConfig = z.infer<typeof ConfigSchema>

export const webhookKind: SourceKind<WebhookConfig> = {
  kind: 'webhook',
  title: { zh: 'Webhook 队列', en: 'Webhook queue' },
  description: { zh: '接收 webhook 队列里下列对话的消息。', en: 'Receives the messages of these conversations from the webhook queue.' },
  schema: ConfigSchema,
  fields: [
    { key: 'conversations', type: 'rows', label: { zh: '接收的对话', en: 'Conversations' }, columns: [
      { key: 'id', type: 'text', label: { zh: '对话', en: 'Conversation' }, pattern: '[a-z0-9-]+' },
      { key: 'listen', type: 'select', label: { zh: '接收', en: 'Receive' }, options: [
        { value: 'mentions', label: { zh: '仅 @', en: '@ only' } }, { value: 'all', label: { zh: '全部消息', en: 'All' } }] },
    ] },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 10, max: 3600,
      label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
  ],
  health: ['webhook'],
  // find, scope, channel, threadContext, policy and environment follow in the next steps.
}
```

- `kind` — стабильный id Источника. Он появляется в `source` Триггера, префиксах ключей Треда, блоке настроек `source:webhook` и Политике Источника.
- `schema` проверяет сохранённую конфигурацию и подставляет значения по умолчанию. Прежде чем оператор сохранит экземпляр, реестр создаёт включённый экземпляр из этих значений по умолчанию. Делайте значения по умолчанию приёмом ничего; этот пример по умолчанию не имеет бесед.
- `fields` генерирует форму настроек Источника без пользовательского кода панели. Поле `rows` редактирует записи с ключом по первому столбцу; `advanced` скрывает менее частые настройки. Реализуйте `refreshLabels`, если Источник может разрешать id в отображаемые имена. Сохраните эти имена под `KV.sources.labels(kind)`. Столбцы с `choose` и `refresh` тогда могут их предлагать.
- Опциональный `facts(deployment)` показывает значения, выведенные настройкой, например аккаунт за CLI. Настройка в настоящее время проверяет только поля GitHub и Feishu, перечисленные в `SETUP_FIELDS`, поэтому этот пример не даёт фактов.
- `health` объявляет записи здоровья Источника, изначально `starting`. Регистрация заявляет каждое имя и отказывает при коллизиях с записями, такими как `runtime`, `reply`, `worker` или видами эффектов. Используйте имя вида и резервируйте `sync:<id>` для синхронизаций Политики. Ошибка `error` заставляет скрипт `status` завершиться с кодом 2, а ежечасную проверку уведомить оператора, поэтому сообщайте о ней только тогда, когда может потребоваться действие человека.

### 3. Переведите сообщение в Триггер

Проверяйте ответы CLI до их преобразования:

```ts
/** One message as `hookq pull` and `hookq thread` print it. */
const MessageSchema = z.looseObject({
  id: z.string().min(1), conversation: z.string().min(1), thread: z.string().optional(),
  sender: z.looseObject({ id: z.string(), bot: z.boolean().default(false) }), mentions_me: z.boolean().default(false),
  text: z.string(), at: z.string(), url: z.string().optional(),
})
type QueueMessage = z.infer<typeof MessageSchema>
/** The answer of `hookq pull`, whose items are read one by one, and of `hookq thread`. */
const PageSchema = z.looseObject({ me: z.string(), items: z.array(z.unknown()), next: z.number().int() })
const ThreadPageSchema = z.looseObject({ items: z.array(MessageSchema), next: z.string().optional() })
```

```ts
/** The Trigger of one queue message; the agent's own messages produce none. */
export function webhookTrigger(message: QueueMessage, me: string): Trigger | undefined {
  if (message.sender.id === me) return undefined
  const thread = `${message.conversation}:${message.thread ?? message.id}`
  return {
    id: key('webhook', message.id),
    source: 'webhook',
    threads: [{ source: 'webhook', id: thread }],
    actor: { source: 'webhook', id: message.sender.id },
    human: !message.sender.bot,
    ...(message.mentions_me ? { addressed: 'mention' as const } : {}),
    at: message.at,
    text: message.text,
    channel: { source: 'webhook', thread: `webhook:${thread}`,
      address: { conversation: message.conversation, message: message.id, ...(message.url ? { url: message.url } : {}) } },
    ...(message.url ? { url: message.url } : {}),
    meta: { conversation: message.conversation, messageId: message.id, root: message.thread ?? message.id },
  }
}
```

- **Стабильные id.** Выводите id Триггера из id очереди через `key`. `Engine.receive` возвращает `duplicate` для сохранённых id, а дублирующиеся принятия создают только один Тикет. Повторное чтение сообщений поэтому безопасно. Чтобы считать правки новыми событиями, включите версию правки в id, как это делает GitHub с `updated_at` комментария.
- **Треды.** Первый Тред основной и владеет Оценкой. Дополнительные Треды добавляют контекст Correlation. Источник выбирает id; его полный ключ — `webhook:<id>`.
- **Отправитель.** Используйте нативные для Источника id в `actor`. Задавайте `human: false` для ботов и CI. Перечисленные боты могут становиться только предполагаемыми кандидатами. Пустой id действующего лица, как для CI, использует ячейку приёма для не перечисленных, не обращающихся отправителей. Задавайте `addressed` как `mention` или `direct`, только когда сообщение действительно обращается к агенту; это даёт сообщению разрешённого человека явную силу. Никогда не производите Триггер для собственного сообщения агента.
- **Адресат ответа и метаданные.** `channel` определяет, куда идут ответы; `url` ссылается на исходное сообщение. `channel.thread` группирует сообщения для упорядоченной доставки: более поздние сообщения Тикета ждут за своими более ранними, пока более раннее не провалится три раза. Другие Тикеты не ждут. Держите специфичные для Источника поля в `meta`, например принимающую беседу и корень Треда. И `meta`, и `text` — недоверенные данные, а не авторизация.

Агенты могут читать новый вид через `orchestrator_read trigger/<id>` и `thread/<key>`. Они показывают текст сообщения, положение и соседние Триггеры. Новый вид не получает автоматически встроенный навык, ресурсы для записей исходного сервиса или привязку pull request'ов.

Текстовый поиск работает без дополнительного кода. Реализуйте `find(query)`, когда люди используют специфичные для Источника ссылки, такие как id сообщений, URL или `#12`. Возвращайте ключи Тредов и условия поиска, которые эти ссылки определяют:

```ts
  find: query => ({ threads: [], terms: [...new Set(query.match(/\bm[0-9]+\b/g) ?? [])] }),
```

Здесь id сообщения очереди в запросе, например `m42`, ищет по нему Триггеры.

### 4. Что Источник принимает: scope

```ts
  scope({ meta }, config) {
    const conversation = config.conversations.find(item => item.id === meta.conversation)
    if (!conversation) return { listened: false, reason: 'conversation_not_listed' }
    return { listened: true, observed: conversation.listen === 'all', row: conversation.id }
  },
```

Engine вызывает `scope` через `SourceRegistry` для каждого входящего Триггера. Сообщения вне области сохраняются как отфильтрованные с их причиной и не создают Тред. Передавайте сообщения в `receive`, а не молча отбрасывайте их в цикле опроса, чтобы панель могла объяснить фильтрацию.

`observed: true` означает, что Источник принимает не адресованные сообщения в этой области, позволяя для них решения таблицы приёма. `row` определяет соответствующую строку приёма.

Перепроверка вызывает `scope` с сохранёнными метаданными Мандата. Делайте его зависимым только от `meta` и конфигурации. Возобновление требует `listened`, не `observed`. Без `scope` вид принимает каждый произведённый им Триггер, но не наблюдает ни один.

### 5. Ответы: Канал

```ts
  channel: {
    allowed: (address, config) => config.conversations.some(item => item.id === address.conversation),
    send: sendWebhook,
    link: address => ({ url: address.url ?? '',
      label: { zh: `Webhook 对话 ${address.conversation}`, en: `Webhook conversation ${address.conversation}` } }),
  },
```

```ts
export async function sendWebhook(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { conversation, message: to } = message.channel.address
  if (!conversation || !to) throw new Error('Missing webhook reply target')
  try {
    await host.commands.run('hookq', ['reply', '--conversation', conversation, '--to', to, '--key', message.id,
      '--text', message.text])
    return 'sent'
  } catch (error) {
    if (error instanceof CliError && error.code === 410) return 'gone'
    throw error
  }
}
```

- **Идемпотентная отправка.** Outbox вызывает `SourceRegistry.send`, который вызывает `channel.send`. Сообщения ждут, пока плагин Источника выгружен. Отправка может провалиться после того, как удалённый сервис её получил, поэтому повторы не должны дублировать сообщения. Используйте `message.id` как ключ идемпотентности: `hookq` поддерживает `--key`; GitHub хранит скрытый маркер комментария; Feishu принимает ключ идемпотентности.
- **Постоянный против повторяемого отказа.** Возвращайте `sent` при успехе и `gone` только тогда, когда доставка навсегда невозможна, как 410 в примере. Пропавшее сообщение сохраняется как отброшенное и никогда снова не ставится в очередь; оно появляется в `GET sources` и на странице Источника. Бросайте исключение для других неудач, чтобы Outbox повторил через 5 секунд, удваивая до 300 секунд. `CliError.code` — это код, сообщаемый выводом CLI.
- **Разрешённые адресаты.** `allowed(address, config)` проверяет только сохранённый адрес и текущую конфигурацию. Помещайте каждый требуемый факт в адрес; например, Feishu записывает, является ли чат прямым. Адресат, которого больше не слушают, отбрасывается, а отключённый Источник оставляет сообщения ждущими. Без `allowed` все адреса разрешены, пока Источник включён.
- **Ссылки.** `link(address, links)` возвращает URL и метку, которые панель показывает через `SourceRegistry.link`.

### 6. Контекст Треда для оценок

```ts
  threadContext: {
    messageId: trigger => String(trigger.meta.messageId ?? ''),
    // A queue thread is flat: its root, and the message a reply answers, are on its first page, as on GitHub.
    read: async (commands, trigger, _part, cursor) => {
      const page = ThreadPageSchema.parse(JSON.parse(await commands.run('hookq', ['thread', '--conversation',
        String(trigger.meta.conversation), '--root', String(trigger.meta.root), '--json', ...(cursor ? ['--after', cursor] : [])])))
      const messages = page.items.map(item => ({ id: item.id, from: item.sender.id, at: item.at, text: item.text,
        ...(item.sender.bot ? { bot: true as const } : {}), ...(item.url ? { url: item.url } : {}) }))
      return { messages, ...(page.next ? { next: page.next } : {}), body: { messages } }
    },
  },
```

Проактивной оценке нужна беседа вокруг Триггера. `orchestrator_eval` читает начальное окно; `orchestrator_eval_read` раскрывает страницы, корень или родительское сообщение. Реализуйте опциональный интерфейс `threadContext`, чтобы предоставить эти чтения:

- `read(commands, trigger, part, cursor, config)` возвращает `ContextPart`. Его `messages` используют `ContextMessage`: `{id, from, at, text}` плюс применимые поля `bot`, `deleted`, `reply_to`, `url`, `path` и `line`. `next` опускается на последней странице. `body` — это содержимое, показываемое оценивающей Сессии, здесь те же сообщения. Опциональный `status` может описывать особые результаты, такие как `chat_neighbours` Feishu. `part` — это `thread`, `root` или `parent`.
- `messageId(trigger)` находит собственное сообщение Триггера среди них.
- `images(text)` и `image(…)` предназначены для вида, чьи сообщения несут изображения, как у Feishu; пример их опускает.

Вид без `threadContext` не даёт оценкам контекста Треда; собственный текст Триггера остаётся читаемым.

Если сообщения отвечают на более ранние, добавьте `repliesTo(trigger)`. Он возвращает соответствующий id Триггера, позволяя уведомлениям фоллоу-апов и Входам воркера показывать сообщение, на которое отвечено, когда оно сохранено. Например, если `hookq` поставляет `reply_to`, а трансляция хранит его как `meta.replyTo`:

```ts
  repliesTo: trigger => typeof trigger.meta.replyTo === 'string' ? key('webhook', trigger.meta.replyTo) : undefined,
```

### 7. Кто может просить: часть Источника в Политике

```ts
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().min(1), name: z.string().trim().max(100).optional() }).strict())
      .default([]) }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的发送者', en: 'Senders who may originate work' }, columns: [
      { key: 'id', type: 'text', label: { zh: '发送者', en: 'Sender' } },
      { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] }],
    explicit: { zh: '名单里的人在消息里 @ 智能体。', en: 'Someone on the list mentions the agent in a message.' },
    rows: stored => ConfigSchema.parse(stored).conversations.map(conversation => {
      const all = conversation.listen === 'all'
      return { id: conversation.id, label: conversation.id, note: all ? { zh: '全部消息', en: 'All' } : { zh: '仅 @', en: '@ only' },
        cells: { listedUnaddressed: all, unlistedAddressed: true, unlistedUnaddressed: all } }
    }),
  },
```

- `schema` проверяет Политику Источника, включая id отправителей `allowed`. Сравнение id нечувствительно к регистру. Таблицы приёма проверяются отдельно и разделяются между видами. Эта часть Политики сохраняется в `policy.sources.webhook` и вносит вклад в версию Политики.
- `fields` генерирует форму в разделе **Eval → On each Source**, начиная с `allowed`. `explicit` объясняет, как обращаться к агенту. Опциональный `unnamed: {person, bot}` поставляет отображаемые метки для непрозрачных id, таких как `ou_…` Feishu; этот пример его опускает, потому что id очереди — читаемые имена.
- `rows(config)` перечисляет области приёма и их доступные ячейки. Каждый id строки должен соответствовать `row`, возвращаемому `scope`. Ячейки не адресованных сообщений доступны только там, где Источник наблюдает эти сообщения. Виды без `rows` используют ячейки по умолчанию.
- Опциональный `bots` перечисляет ботов, допущенных к предполагаемому кандидатству, используя ту же форму записи, что и `allowed`. Без него ни один бот не допускается.
- Опциональный `sync: {label, ready(part), run(host, part, signal)}` обновляет состав при запуске и по **Sync now**. Feishu использует состав чата. Неудачи появляются под `sync:<id>` и повторяются через минуту, удваиваясь до одного часа, пока не удастся.

### 8. Переменные для Исполнителя

```ts
  environment: {
    variables: [{ key: 'DSH_SUPERAGENT_WEBHOOK_CONVERSATION', description: {
      zh: '接下工单的 webhook 对话；工单不是从这个来源来的时为空',
      en: 'The webhook conversation that started the ticket; empty when the ticket did not start on this Source' } }],
    values: ({ trigger }) => ({
      DSH_SUPERAGENT_WEBHOOK_CONVERSATION: trigger?.source === 'webhook' ? String(trigger.meta.conversation ?? '') : '' }),
  },
```

Настройки исполнения показывают объявленные `variables` рядом с командой подготовки, даже когда Источник отключён. Пока он включён, `values` поставляет специфичные для Тикета значения, используя развёртывание, конфигурацию и исходный Триггер.

Команда подготовки читает переменные окружения; воркер читает их значения в своих инструкциях. Используйте префикс `DSH_SUPERAGENT_<KIND>_…`, возвращайте пустое значение для Тикетов из другого Источника и никогда не включайте учётные данные.

### 9. Точка входа плагина и его цикл

```ts
export const name = 'dsh-superagent-webhook'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(webhookKind), 'webhook: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, webhookKind)
    const controller = new AbortController()
    // DSH ends its process on an unhandled rejection, so a failure that escapes the loop becomes the Source's health.
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report('webhook', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
```

Плагин внедряет `orchestrator`. Его первый эффект регистрирует вид и отменяет регистрацию при удалении. Второй запускает цикл опроса с `SourceContext`. Удаление прерывает цикл и ждёт завершения, в том числе во время остановки или перезапуска приложения.

```ts
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  // Setup restarts dsh-superagent once it resolves the accounts; until then the Source reads nothing.
  if (!ctx.configured()) { ctx.report('webhook', health('paused', 'setupPending')); return }
  let failures = 0
  while (!signal.aborted) {
    const config = ctx.config<WebhookConfig>('webhook')
    if (!config) ctx.report('webhook', health('paused', 'sourceOff'))
    else {
      const at = new Date().toISOString()
      try {
        const { read, unreadable } = await pollQueue(ctx, signal)
        failures = 0
        ctx.report('webhook', { state: 'ready', detail: `${read} messages, ${unreadable} unreadable`, at })
      } catch (error) {
        failures += 1
        // One network failure is retried on the next round; three in a row need a person.
        if (!signal.aborted && failures >= 3) {
          ctx.report('webhook', health('error', 'pollFailures', { count: String(failures), error: String(error) }))
        }
      }
    }
    await delay((config?.pollSeconds ?? 30) * 1000, undefined, { signal }).catch(() => {})
  }
}

/** Read the queue after the cursor, take in each message, then move the cursor past them. */
export async function pollQueue(ctx: SourceContext, signal: AbortSignal): Promise<{ read: number; unreadable: number }> {
  const after = ctx.state.get(KV.webhook.cursor) ?? 0
  const output = await ctx.commands.withSignal(signal).run('hookq', ['pull', '--after', String(after), '--json'])
  const page = PageSchema.parse(JSON.parse(output))
  let unreadable = 0
  for (const item of page.items) {
    if (signal.aborted) throw new Error('The webhook Source stopped during the read')
    const message = MessageSchema.safeParse(item)
    if (!message.success) { unreadable++; continue }
    const trigger = webhookTrigger(message.data, page.me)
    if (!trigger) continue
    await ctx.receive(trigger)
    const conversation = { label: { zh: '对话', en: 'Conversation' }, value: message.data.conversation }
    for (const ref of trigger.threads) ctx.threads.describe(threadKey(ref), { facts: { conversation } })
  }
  ctx.state.set(KV.webhook.cursor, page.next)
  return { read: page.items.length, unreadable }
}
```


- **Настройка и переключатель.** Ждите `ctx.ready` и не читайте ничего, пока `ctx.configured()` ложен. Читайте `ctx.config(kind)` на каждом раунде: он не определён, пока Источник выключен.
- **Курсоры.** Храните позиции чтения в `ctx.state`, используя типизированные записи в `KV` (`src/kv.ts`), такие как `webhook: {cursor: record<number>('webhook-cursor')}`. `tests/store.spec.ts` требует, чтобы литералы ключей появлялись только в этом реестре. Внешние пакеты могут определять ключи через экспортируемые `record` и `family`. Присвоение `undefined` удаляет запись; `ctx.atomic` группирует записи в транзакцию.

  Продвигайте курсор только после того, как каждый покрытый Триггер сохранён. Прерванный раунд оставляет курсор неизменным; стабильные id делают повтор безопасным. Для курсоров по времени `cursorAt(started)` из `src/sources/poll.ts` вычитает пять секунд, чтобы учесть поздние записи удалённой стороны.
- **Метаданные Треда.** После приёма Триггера вызовите `ctx.threads.describe(key, {label, url, facts})`, чтобы заполнить его отображаемую информацию. `ctx.threads.patch(key, meta)` делегирует `threads.patchMeta`, задавая принадлежащие Источнику ключи или удаляя их, когда значение `undefined`. Оба игнорируют отсутствующие Треды, включая Треды отфильтрованных Триггеров.
- **Ошибки на элемент.** Считайте неполадные элементы и продолжайте, а не проваливайте весь пакет. `validItems(item, list, tally)` в `src/infra/commands.ts` поддерживает этот шаблон. Для независимо опрашиваемых Тредов используйте `pollThreads` из `src/sources/poll.ts`; он записывает каждую неудачу как `pollError`. Его предикат `polled` хранит живые подписки и окно в две недели после более позднего из последнего Триггера и завершения Тикета.
- **Здоровье.** Пишите только объявленные записи через `ctx.report`. `health(state, code, values)` даёт фиксированные сообщения, такие как `setupPending`, `sourceOff` и `pollFailures`. Считайте последовательные неудачи до сообщения `error`.
- **Прерывание.** Передавайте сигнал в `ctx.commands.withSignal(signal)` и в `delay`, и проверяйте его между элементами, чтобы остановка или перезапуск сразу завершали цикл.

Этот пример не отправляет уведомления, порождённые Источником. Источник, которому они нужны, вызывает `ctx.notify`; Outbox доставляет их как другие ответы.

Он также не привязывает Треды к завершению Тикета. Используйте `ctx.tickets.bindThread` и `threadClosed`, только когда жизненный цикл Треда Источника определяет, завершена ли работа, как это делают pull request'ы GitHub. Engine всё равно решает, когда Тикет завершается.

### 10. Зарегистрируйте плагин

Соберите модуль как собственную точку входа в `tsdown.config.ts`:

```ts
entry: { index: 'src/index.ts', 'github-watch': 'src/sources/github.ts', 'feishu-watch': 'src/sources/feishu.ts',
  'webhook-watch': 'src/sources/webhook.ts' },
```

Затем экспортируйте собранный файл в `package.json`, добавив `"./webhook-watch": "./lib/webhook-watch.js"` к `exports`, и добавьте плагин в список `insert` в `cordis.patch.yml` бандла, отключённым, как Feishu:

```yaml
    - id: dsh-superagent-webhook
      name: dsh-superagent/webhook-watch
      disabled: true
```

Включите плагин в `cordis.patch.yml` профиля с `id: dsh-superagent-webhook` и `disabled: false`. Соберите и перезапустите. Новый Источник появляется в настройках Sources и в разделе **Eval → On each Source**.

Добавьте его модуль и спец-файл в таблицы модулей и тестов в [007 Architecture](007-architecture.md). `tests/docs.spec.ts` проверяет, что оба указателя полны.

### 11. Тесты

Создайте `tests/webhook.spec.ts`, используя шаблон из `tests/sources.spec.ts`: настоящий Store во временном каталоге, `SourceRegistry` с `HealthBoard`, Engine с заглушечными портами и `SourceContext` из `sourceContextOf`.

Сымитируйте вызовы CLI, шпионя за `Commands.run`. Также шпионьте за `withSignal`, потому что он обычно возвращает новый экземпляр `Commands`.

```ts
function host(overrides: Partial<SourceContextDeps> = {}) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'webhook-')), 'db.sqlite'))
  store.saveSettings(SettingsSchema.parse({
    sources: { webhook: { enabled: true, config: { conversations: [{ id: 'ops', listen: 'mentions' }] } } },
    policy: { sources: { webhook: { allowed: [{ id: 'alice' }] } } },
  }))
  // The registry claims the kind's health entries on the board, where the test reads them.
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(webhookKind)
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources),
    assessor: { request: vi.fn() }, executor: { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() },
    outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn() } })
  const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
  const receive = vi.fn((trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  // The Source's own notices go to the outbox, which keeps their receipts and sends nothing here.
  const deps: SourceContextDeps = { store, engine, outbox: { send: message => { store.receipts.add(message) } }, commands, sources,
    deployment: testDeployment(), ready: Promise.resolve(), configured: () => true, receive, ...overrides }
  return { ...deps, store, engine, commands, receive, health: board.all, ctx: sourceContextOf(deps, webhookKind) }
}
/** The queue as `hookq` answers it. */
function queue(h: ReturnType<typeof host>, answer: () => unknown) {
  vi.spyOn(h.commands, 'withSignal').mockReturnValue(h.commands)
  return vi.spyOn(h.commands, 'run').mockImplementation(async () => JSON.stringify(answer()))
}

it('takes in what the queue holds after the cursor, once, and moves the cursor after it', async () => {
  const h = host()
  queue(h, () => ({ me: 'agent', items: [message('m1'), { id: 'broken' }, message('m2', { conversation: 'elsewhere' })], next: 3 }))
  expect(await pollQueue(h.ctx, new AbortController().signal)).toEqual({ read: 3, unreadable: 1 })
  expect(await h.receive.mock.results[0]!.value).toBe('stored')
  expect(await h.receive.mock.results[1]!.value).toBe('filtered')
  expect(h.store.get(KV.webhook.cursor)).toBe(3)
  // An allowed sender who mentions the agent makes an explicit request.
  expect(h.engine.candidate(key('webhook', 'm1'))?.strength).toBe('explicit')
  await pollQueue(h.ctx, new AbortController().signal)
  expect(await h.receive.mock.results[2]!.value).toBe('duplicate')
  h.store.close()
})
```

`message(id, fields)` строит элемент очереди. Покройте как минимум:

- трансляцию: стабильный id, Тред, действующее лицо, `human` и `addressed`, и отсутствие Триггера для собственного сообщения агента;
- раунд: Триггеры сохраняются один раз, один вне области `filtered`, курсор продвигается за ними, упоминание разрешённого отправителя оценивается как `explicit`;
- оборванный раунд, который сохраняет свой курсор;
- `send`: `sent`, `gone` только для 410 и бросок для любой другой неудачи, с ошибкой CLI, построенной через `commandError`;
- контекст Треда: сообщения страницы и курсор следующей, как `tests/registry.spec.ts` читает Треды вида через `SourceRegistry.threadContext`;
- плагин: `apply` регистрирует вид и сообщает `setupPending`, пока настройка ждёт, его уборщики отменяют регистрацию вида, а неудача, выходящая из цикла, становится здоровьем Источника вместо необработанного отклонения;
- часть Источника в Политике и его строки приёма, как `tests/registry.spec.ts` и `tests/policy.spec.ts` проверяют часть Источника Feishu.

### Контрольный список

1. Сопоставьте Триггеры, Треды, действующих лиц, адреса Каналов и области приёма.
2. Напишите вид: `schema`, `fields`, `health` и `facts`, если настройка что-то выводит.
3. Переведите события в Триггеры со стабильными id и отбросьте собственные сообщения агента.
4. Решите, что Источник принимает в `scope`, только из `meta`.
5. Дайте ему Канал, чей `send` публикует каждое сообщение один раз и отвечает `gone`, только когда беседа никогда не сможет его принять.
6. Дайте оценкам его контекст Треда, если он может читать Тред.
7. Дайте ему часть Политики с `allowed` и строками приёма.
8. Зарегистрируйте его переменные среды исполнения.
9. Напишите точку входа плагина и цикл, который ждёт настройку, следует переключателю, продвигает курсоры после `receive`, хранит ошибки на элемент, сообщает здоровье и останавливается по прерыванию; назовите курсоры в `KV`.
10. Добавьте точку сборки, экспорт и вставку в `cordis.patch.yml` и перечислите модуль и его спец-файл в таблицах 007.
11. Протестируйте это так, как `tests/sources.spec.ts` тестирует другие Источники.