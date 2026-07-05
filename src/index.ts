import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Markup, Telegraf } from "telegraf";
import type { Context } from "telegraf";

const MAX_BOOKINGS_PER_SLOT = 10;
const WEEKS_TO_SHOW = 8;
const USER_PROFILES_FILE = "data/user-profiles.json";
const DAY_NAMES = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
const DEFAULT_SLOT_TIMES = [
  "07:00",
  "08:30",
  "09:00",
  "10:00",
  "10:30",
  "11:00",
  "12:00",
  "17:00",
  "18:30",
  "19:00",
  "20:00",
];

type Draft = {
  weekStart: Date;
  includedDates: Set<string>;
  timesByDate: Map<string, Set<string>>;
  restDates: Set<string>;
};

type BookingUser = {
  id: number;
  name: string;
  username?: string;
};

type Slot = {
  id: string;
  dateKey: string;
  time: string;
  bookings: Map<number, BookingUser>;
};

type Schedule = {
  id: string;
  createdBy: number;
  groupChatId: number;
  includedDates: string[];
  slots: Slot[];
  messageId?: number;
};

type UserProfile = {
  name: string;
  updatedAt: string;
};

type PendingNameRequest = {
  mode: "booking" | "profile";
  requestedAt: number;
  scheduleId?: string;
  slotId?: string;
};

type BotContext = Context;
type CallbackContext = Context;

const botToken = process.env.BOT_TOKEN;
if (!botToken) {
  throw new Error("BOT_TOKEN is required. Copy .env.example to .env and set it.");
}

const groupChatId = process.env.GROUP_CHAT_ID
  ? Number(process.env.GROUP_CHAT_ID)
  : undefined;

const trainerIds = parseNumberList(process.env.TRAINER_IDS);
const slotTimes = parseSlotTimes(process.env.SLOT_TIMES);
const bot = new Telegraf(botToken);

const drafts = new Map<number, Draft>();
const schedules = new Map<string, Schedule>();
const userProfiles = loadUserProfiles();
const pendingNameRequests = new Map<number, PendingNameRequest>();
let activeScheduleId: string | undefined;

if (trainerIds.size === 0) {
  console.warn(
    "TRAINER_IDS is empty. Any user can create schedules in private chat.",
  );
}

bot.start(async (ctx) => {
  if (!ctx.from) return;

  if (ctx.chat.type !== "private") {
    await ctx.reply("Напишите мне в личку, чтобы открыть меню тренера.");
    return;
  }

  if (!isTrainer(ctx.from.id)) {
    if (pendingNameRequests.has(ctx.from.id)) {
      await ctx.reply(namePromptText(), namePromptMarkup());
      return;
    }

    await ctx.reply(
      [
        "Привет! Я бот для записи на тренировки.",
        "",
        "Чтобы изменить имя для записи, напишите /name.",
        "Для отмены записи нажмите кнопку отмены в расписании группы.",
      ].join("\n"),
    );
    return;
  }

  await ctx.reply(
    [
      "Привет! Здесь можно собрать расписание на неделю.",
      "",
      "Нажмите кнопку ниже, выберите даты и свободное время, затем опубликуйте расписание в группу.",
    ].join("\n"),
    Markup.inlineKeyboard([
      [Markup.button.callback("☀️ Создать расписание", "trainer:new")],
    ]),
  );
});

bot.command("new", async (ctx) => {
  if (!ctx.from || !ensurePrivateTrainer(ctx)) return;
  await showWeekPicker(ctx);
});

bot.command("whoami", async (ctx) => {
  if (!ctx.from) return;
  await ctx.reply(`Ваш Telegram ID: ${ctx.from.id}`);
});

bot.command("chatid", async (ctx) => {
  await ctx.reply(`ID этого чата: ${ctx.chat.id}`);
});

bot.command("name", async (ctx) => {
  if (!ctx.from) return;

  if (ctx.chat.type !== "private") {
    await ctx.reply("Имя для записи можно настроить только в личке с ботом.");
    return;
  }

  pendingNameRequests.set(ctx.from.id, {
    mode: "profile",
    requestedAt: Date.now(),
  });

  const currentName = userProfiles.get(ctx.from.id)?.name;
  await ctx.reply(
    [
      currentName ? `Сейчас вы записываетесь как: ${currentName}` : null,
      namePromptText(),
    ]
      .filter(Boolean)
      .join("\n\n"),
    namePromptMarkup(),
  );
});

bot.on("text", async (ctx) => {
  if (!ctx.from || ctx.chat.type !== "private") return;

  const pending = pendingNameRequests.get(ctx.from.id);
  if (!pending) return;

  const text = ctx.message.text;
  if (text.startsWith("/")) {
    await ctx.reply("Напишите имя обычным текстом, без команды.");
    return;
  }

  const name = normalizeDisplayName(text);
  if (!name) {
    await ctx.reply("Имя должно быть от 2 до 30 символов. Попробуйте еще раз.");
    return;
  }

  saveUserProfile(ctx.from.id, name);
  pendingNameRequests.delete(ctx.from.id);

  if (pending.mode === "booking") {
    await completePendingBooking(ctx, pending, name);
    return;
  }

  await ctx.reply(`Готово, буду записывать вас как: ${name}`);
});

bot.on("callback_query", async (ctx) => {
  const data = getCallbackData(ctx);
  if (!data || !ctx.from) {
    await ctx.answerCbQuery();
    return;
  }

  if (data.startsWith("trainer:")) {
    await handleTrainerCallback(ctx, data);
    return;
  }

  if (data.startsWith("book:")) {
    await handleBookingCallback(ctx, data);
    return;
  }

  if (data.startsWith("cancel:")) {
    await handleCancelCallback(ctx, data);
    return;
  }

  await ctx.answerCbQuery();
});

async function handleTrainerCallback(ctx: CallbackContext, data: string) {
  if (!ctx.from || !isTrainer(ctx.from.id)) {
    await ctx.answerCbQuery("Это меню доступно только тренеру.", {
      show_alert: true,
    });
    return;
  }

  if (ctx.chat?.type !== "private") {
    await ctx.answerCbQuery("Откройте меню тренера в личке с ботом.", {
      show_alert: true,
    });
    return;
  }

  const [, action, ...params] = data.split(":");

  if (action === "new") {
    await ctx.answerCbQuery();
    await showWeekPicker(ctx, true);
    return;
  }

  if (action === "week") {
    const [weekStartKey] = params;
    if (!weekStartKey) {
      await ctx.answerCbQuery("Неделя не найдена.", { show_alert: true });
      return;
    }

    const draft = createDraft(dateFromKey(weekStartKey));
    drafts.set(ctx.from.id, draft);

    await ctx.answerCbQuery();
    await replaceCallbackMessage(ctx, renderDatesText(draft), datesKeyboard(draft));
    return;
  }

  const draft = drafts.get(ctx.from.id);
  if (!draft) {
    await ctx.answerCbQuery("Черновик не найден. Создайте расписание заново.", {
      show_alert: true,
    });
    return;
  }

  if (action === "noop") {
    await ctx.answerCbQuery();
    return;
  }

  if (action === "dates") {
    await ctx.answerCbQuery();
    await replaceCallbackMessage(ctx, renderDatesText(draft), datesKeyboard(draft));
    return;
  }

  if (action === "open-date") {
    const [dateKey] = params;
    if (!dateKey || !isDraftDate(draft, dateKey)) {
      await ctx.answerCbQuery("Дата не найдена.", { show_alert: true });
      return;
    }

    await ctx.answerCbQuery();
    await replaceCallbackMessage(
      ctx,
      renderTimesText(draft, dateKey),
      timesKeyboard(draft, dateKey),
    );
    return;
  }

  if (action === "toggle-time") {
    const [dateKey, rawTime] = params;
    const time = decodeTime(rawTime);
    if (!dateKey || !time || !isDraftDate(draft, dateKey)) {
      await ctx.answerCbQuery("Время не найдено.", { show_alert: true });
      return;
    }

    draft.includedDates.add(dateKey);
    draft.restDates.delete(dateKey);
    const times = ensureDateTimes(draft, dateKey);
    if (times.has(time)) {
      times.delete(time);
      if (times.size === 0) {
        draft.includedDates.delete(dateKey);
        draft.timesByDate.delete(dateKey);
      }
    } else {
      times.add(time);
    }

    await ctx.answerCbQuery();
    await replaceCallbackMessage(
      ctx,
      renderTimesText(draft, dateKey),
      timesKeyboard(draft, dateKey),
    );
    return;
  }

  if (action === "toggle-rest") {
    const [dateKey] = params;
    if (!dateKey || !isDraftDate(draft, dateKey)) {
      await ctx.answerCbQuery("Дата не найдена.", { show_alert: true });
      return;
    }

    if (draft.restDates.has(dateKey)) {
      draft.restDates.delete(dateKey);
      draft.includedDates.delete(dateKey);
    } else {
      draft.restDates.add(dateKey);
      draft.includedDates.add(dateKey);
      draft.timesByDate.delete(dateKey);
    }

    await ctx.answerCbQuery();
    await replaceCallbackMessage(
      ctx,
      renderTimesText(draft, dateKey),
      timesKeyboard(draft, dateKey),
    );
    return;
  }

  if (action === "remove-date") {
    const [dateKey] = params;
    if (!dateKey || !isDraftDate(draft, dateKey)) {
      await ctx.answerCbQuery("Дата не найдена.", { show_alert: true });
      return;
    }

    draft.includedDates.delete(dateKey);
    draft.timesByDate.delete(dateKey);
    draft.restDates.delete(dateKey);

    await ctx.answerCbQuery("Дата убрана из расписания.");
    await replaceCallbackMessage(ctx, renderDatesText(draft), datesKeyboard(draft));
    return;
  }

  if (action === "publish") {
    await publishDraft(ctx, draft);
    return;
  }

  await ctx.answerCbQuery();
}

async function handleBookingCallback(ctx: CallbackContext, data: string) {
  const [, action, scheduleId, ...params] = data.split(":");
  const schedule = schedules.get(scheduleId);

  if (!ctx.from || !schedule) {
    await ctx.answerCbQuery("Это расписание уже недоступно.", {
      show_alert: true,
    });
    return;
  }

  if (!isActiveSchedule(schedule)) {
    await closePublishedSchedule(ctx, schedule);
    await ctx.answerCbQuery("Запись по этому расписанию уже закрыта.", {
      show_alert: true,
    });
    return;
  }

  if (action === "date") {
    const [dateKey] = params;
    if (!dateKey || !hasBookableSlots(schedule, dateKey)) {
      await ctx.answerCbQuery("На эту дату нет свободных слотов.", {
        show_alert: true,
      });
      return;
    }

    await ctx.answerCbQuery();
    await updateScheduleKeyboard(ctx, scheduleTimesKeyboard(schedule, dateKey));
    return;
  }

  if (action === "back") {
    await ctx.answerCbQuery();
    await updateScheduleKeyboard(ctx, scheduleKeyboard(schedule));
    return;
  }

  if (action !== "slot") {
    await ctx.answerCbQuery();
    return;
  }

  const [slotId] = params;
  const slot = schedule.slots.find((candidate) => candidate.id === slotId);
  if (!slot) {
    await ctx.answerCbQuery("Это время уже недоступно.", {
      show_alert: true,
    });
    return;
  }

  if (slot.bookings.has(ctx.from.id)) {
    await ctx.answerCbQuery("Вы уже записаны на это время.");
    return;
  }

  if (slot.bookings.size >= MAX_BOOKINGS_PER_SLOT) {
    await ctx.answerCbQuery("На это время мест уже нет.", { show_alert: true });
    return;
  }

  const profile = userProfiles.get(ctx.from.id);
  if (!profile) {
    pendingNameRequests.set(ctx.from.id, {
      mode: "booking",
      requestedAt: Date.now(),
      scheduleId,
      slotId: slot.id,
    });

    try {
      await ctx.telegram.sendMessage(
        ctx.from.id,
        namePromptText(),
        namePromptMarkup(),
      );
      await ctx.answerCbQuery("Я написал вам в личку, чтобы уточнить имя.");
    } catch {
      await ctx.answerCbQuery(
        "Чтобы записаться, сначала откройте личку с ботом и нажмите Start.",
        { show_alert: true },
      );
    }
    return;
  }

  slot.bookings.set(ctx.from.id, userFromProfile(ctx, profile.name));
  await updatePublishedSchedule(ctx, schedule);
  await ctx.answerCbQuery(
    `Вы записаны: ${formatDateShort(slot.dateKey)}, ${slot.time}`,
  );
}

async function handleCancelCallback(ctx: CallbackContext, data: string) {
  const [, action, scheduleId, slotId] = data.split(":");
  const schedule = schedules.get(scheduleId);

  if (!ctx.from || !schedule) {
    await ctx.answerCbQuery("Это расписание уже недоступно.", {
      show_alert: true,
    });
    return;
  }

  if (!isActiveSchedule(schedule)) {
    await closePublishedSchedule(ctx, schedule);
    await ctx.answerCbQuery("Это расписание уже закрыто.", {
      show_alert: true,
    });
    return;
  }

  if (action === "start") {
    const bookings = getUserBookings(schedule, ctx.from.id);

    if (bookings.length === 0) {
      await ctx.answerCbQuery("У вас нет записей в этом расписании.");
      return;
    }

    try {
      await ctx.telegram.sendMessage(
        ctx.from.id,
        cancelMenuText(schedule, ctx.from.id),
        cancelKeyboard(schedule, ctx.from.id),
      );
      await ctx.answerCbQuery("Я отправил список записей в личку.");
    } catch {
      await ctx.answerCbQuery(
        "Чтобы отменить запись, сначала откройте личку с ботом и нажмите Start.",
        { show_alert: true },
      );
    }
    return;
  }

  if (action === "slot" && slotId) {
    const slot = schedule.slots.find((candidate) => candidate.id === slotId);
    if (!slot || !slot.bookings.has(ctx.from.id)) {
      await ctx.answerCbQuery("Эта запись уже отменена.");
      await replaceCallbackMessage(
        ctx,
        cancelMenuText(schedule, ctx.from.id),
        cancelKeyboard(schedule, ctx.from.id),
      );
      return;
    }

    slot.bookings.delete(ctx.from.id);
    await updatePublishedSchedule(ctx, schedule);
    await ctx.answerCbQuery(
      `Запись отменена: ${formatDateShort(slot.dateKey)}, ${slot.time}`,
    );
    await replaceCallbackMessage(
      ctx,
      cancelMenuText(schedule, ctx.from.id),
      cancelKeyboard(schedule, ctx.from.id),
    );
    return;
  }

  await ctx.answerCbQuery();
}

async function showWeekPicker(ctx: BotContext, edit = false) {
  if (edit && "editMessageText" in ctx) {
    await replaceCallbackMessage(
      ctx as CallbackContext,
      renderWeeksText(),
      weeksKeyboard(),
    );
    return;
  }

  await ctx.reply(renderWeeksText(), weeksKeyboard());
}

async function publishDraft(ctx: CallbackContext, draft: Draft) {
  const trainerId = ctx.from?.id;
  if (!trainerId) {
    await ctx.answerCbQuery("Не удалось определить тренера.", {
      show_alert: true,
    });
    return;
  }

  if (!groupChatId || Number.isNaN(groupChatId)) {
    await ctx.answerCbQuery("Заполните GROUP_CHAT_ID в .env.", {
      show_alert: true,
    });
    return;
  }

  const schedule = createSchedule(draft, trainerId, groupChatId);
  if (schedule.includedDates.length === 0) {
    await ctx.answerCbQuery("Выберите хотя бы один день.", {
      show_alert: true,
    });
    return;
  }

  try {
    const previousSchedule = getActiveSchedule();
    const message = await ctx.telegram.sendMessage(
      schedule.groupChatId,
      scheduleText(schedule),
      scheduleKeyboard(schedule),
    );
    schedule.messageId = message.message_id;
    schedules.set(schedule.id, schedule);
    activeScheduleId = schedule.id;
    drafts.delete(trainerId);
    await closePublishedSchedule(ctx, previousSchedule);

    await ctx.answerCbQuery("Расписание опубликовано.");
    await replaceCallbackMessage(
      ctx,
      [
        "Готово! Расписание опубликовано в группу.",
        "",
        "Можно создать новое расписание, когда понадобится следующая неделя.",
      ].join("\n"),
      Markup.inlineKeyboard([
        [Markup.button.callback("☀️ Создать новое", "trainer:new")],
      ]),
    );
  } catch (error) {
    console.error("Failed to publish schedule", error);
    await ctx.answerCbQuery(
      "Не получилось отправить расписание. Проверьте GROUP_CHAT_ID и права бота в группе.",
      { show_alert: true },
    );
  }
}

function createDraft(weekStart = startOfWeek(new Date())): Draft {
  return {
    weekStart: startOfWeek(weekStart),
    includedDates: new Set(),
    timesByDate: new Map(),
    restDates: new Set(),
  };
}

function createSchedule(
  draft: Draft,
  trainerId: number,
  targetGroupChatId: number,
): Schedule {
  const includedDates = [...draft.includedDates].sort();
  const slots = includedDates.flatMap((dateKey) => {
    const times = [...(draft.timesByDate.get(dateKey) ?? [])].sort(compareTimes);
    return times.map<Slot>((time) => ({
      id: `${dateKey}_${encodeTime(time)}`,
      dateKey,
      time,
      bookings: new Map(),
    }));
  });

  return {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    createdBy: trainerId,
    groupChatId: targetGroupChatId,
    includedDates,
    slots,
  };
}

function renderWeeksText() {
  return [
    "☀️ Выберите неделю для расписания",
    "",
    "Бот показывает текущую неделю и ближайшие следующие недели.",
  ].join("\n");
}

function weeksKeyboard() {
  const rows = availableWeekStarts().map((weekStart, index) => {
    const labelPrefix = index === 0 ? "Текущая" : `+${index}`;
    return [
      Markup.button.callback(
        `${labelPrefix}: ${weekRangeLabel(weekStart)}`,
        `trainer:week:${dateKey(weekStart)}`,
      ),
    ];
  });

  return Markup.inlineKeyboard(rows);
}

function renderDatesText(draft: Draft) {
  return [
    `☀️ Новое расписание ${weekRangeLabel(draft.weekStart)}`,
    "",
    "Выберите дату, затем отметьте свободное время или выходной.",
    "Дни со слотами отмечены галочкой, выходные — 🌸.",
  ].join("\n");
}

function renderTimesText(draft: Draft, dateKey: string) {
  const selectedTimes = draft.timesByDate.get(dateKey)?.size ?? 0;
  const isRestDay = draft.restDates.has(dateKey);
  return [
    `🌸 ${formatDateWithDay(dateKey)}`,
    "",
    "Кликните на свободное время или отметьте день как выходной.",
    "",
    isRestDay
      ? "Этот день будет опубликован как ВЫХОДНОЙ."
      : selectedTimes > 0
      ? `Выбрано слотов: ${selectedTimes}`
      : "Пока нет выбранных слотов.",
  ].join("\n");
}

function datesKeyboard(draft: Draft) {
  const rows = chunk(weekDateKeys(draft.weekStart), 2).map((dateKeys) =>
    dateKeys.map((dateKey) => {
      const hasSlots = (draft.timesByDate.get(dateKey)?.size ?? 0) > 0;
      const isRestDay = draft.restDates.has(dateKey);
      const mark = hasSlots ? "✅" : isRestDay ? "🌸" : "⬜️";
      return Markup.button.callback(
        `${mark} ${formatDateWithDay(dateKey)}`,
        `trainer:open-date:${dateKey}`,
      );
    }),
  );

  rows.push([
    Markup.button.callback(
      "📣 Опубликовать расписание",
      "trainer:publish",
    ),
  ]);

  return Markup.inlineKeyboard(rows);
}

function timesKeyboard(draft: Draft, dateKey: string) {
  const selectedTimes = draft.timesByDate.get(dateKey) ?? new Set<string>();
  const isRestDay = draft.restDates.has(dateKey);
  const timeRows = chunk(slotTimes, 3).map((times) =>
    times.map((time) =>
      Markup.button.callback(
        `${selectedTimes.has(time) ? "✅" : "⬜️"} ${time}`,
        `trainer:toggle-time:${dateKey}:${encodeTime(time)}`,
      ),
    ),
  );

  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        `${isRestDay ? "✅" : "⬜️"} ВЫХОДНОЙ`,
        `trainer:toggle-rest:${dateKey}`,
      ),
    ],
    ...timeRows,
    [
      Markup.button.callback(
        "🗑 Убрать дату",
        `trainer:remove-date:${dateKey}`,
      ),
    ],
    [Markup.button.callback("← К датам", "trainer:dates")],
    [Markup.button.callback("📣 Опубликовать расписание", "trainer:publish")],
  ]);
}

function scheduleText(schedule: Schedule) {
  const lines = [`☀️ РАСПИСАНИЕ ${scheduleRangeLabel(schedule)}`, ""];

  for (const dateKey of schedule.includedDates) {
    const slots = schedule.slots
      .filter((slot) => slot.dateKey === dateKey)
      .sort((first, second) => compareTimes(first.time, second.time));

    if (slots.length === 0) {
      lines.push(`🌸 ${formatDateWithDay(dateKey)}: ВЫХОДНОЙ 🌸`, "");
      continue;
    }

    lines.push(dayHeader(dateKey), "");
    for (const slot of slots) {
      const participants = participantsLabel(slot);
      lines.push(`⌚️ ${slot.time}${participants ? `: ${participants}` : ""}`);
    }
    lines.push("");
  }

  lines.push("Сначала выберите дату ниже, затем время тренировки.");
  return lines.join("\n");
}

function closedScheduleText(schedule: Schedule) {
  return [
    scheduleText(schedule),
    "",
    "Запись по этому расписанию закрыта. Актуальное расписание опубликовано отдельным сообщением.",
  ].join("\n");
}

function scheduleKeyboard(schedule: Schedule) {
  const dateButtons = schedule.includedDates
    .filter((dateKey) => hasBookableSlots(schedule, dateKey))
    .map((dateKey) =>
      Markup.button.callback(
        formatDateWithDay(dateKey),
        `book:date:${schedule.id}:${dateKey}`,
      ),
    );

  return Markup.inlineKeyboard([
    ...chunk(dateButtons, 2),
    [
      Markup.button.callback(
        "❌ Отменить запись",
        `cancel:start:${schedule.id}`,
      ),
    ],
  ]);
}

function scheduleTimesKeyboard(schedule: Schedule, dateKey: string) {
  const slotButtons = schedule.slots
    .filter((slot) => slot.dateKey === dateKey)
    .sort((first, second) => compareTimes(first.time, second.time))
    .map((slot) =>
      Markup.button.callback(
        slot.time,
        `book:slot:${schedule.id}:${slot.id}`,
      ),
    );

  return Markup.inlineKeyboard([
    ...chunk(slotButtons, 2),
    [Markup.button.callback("← К датам", `book:back:${schedule.id}`)],
    [
      Markup.button.callback(
        "❌ Отменить запись",
        `cancel:start:${schedule.id}`,
      ),
    ],
  ]);
}

function cancelMenuText(schedule: Schedule, userId: number) {
  const bookings = getUserBookings(schedule, userId);
  if (bookings.length === 0) {
    return "У вас больше нет активных записей в этом расписании.";
  }

  return [
    "Ваши записи:",
    "",
    ...bookings.map(
      (slot) => `• ${formatDateWithDay(slot.dateKey)}, ${slot.time}`,
    ),
    "",
    "Нажмите на запись, которую нужно отменить.",
  ].join("\n");
}

function cancelKeyboard(schedule: Schedule, userId: number) {
  const buttons = getUserBookings(schedule, userId).map((slot) =>
    Markup.button.callback(
      `❌ ${formatDateShort(slot.dateKey)} ${slot.time}`,
      `cancel:slot:${schedule.id}:${slot.id}`,
    ),
  );

  if (buttons.length === 0) {
    return Markup.inlineKeyboard([
      [Markup.button.callback("Готово", `cancel:noop:${schedule.id}`)],
    ]);
  }

  return Markup.inlineKeyboard(chunk(buttons, 1));
}

async function updatePublishedSchedule(ctx: CallbackContext, schedule: Schedule) {
  if (!schedule.messageId) return;

  try {
    await ctx.telegram.editMessageText(
      schedule.groupChatId,
      schedule.messageId,
      undefined,
      scheduleText(schedule),
      scheduleKeyboard(schedule),
    );
  } catch (error) {
    console.error("Failed to update schedule message", error);
  }
}

async function updateScheduleKeyboard(
  ctx: CallbackContext,
  markup: ReturnType<typeof Markup.inlineKeyboard>,
) {
  try {
    await ctx.editMessageReplyMarkup(markup.reply_markup);
  } catch (error) {
    console.error("Failed to update schedule keyboard", error);
  }
}

async function closePublishedSchedule(
  ctx: BotContext,
  schedule: Schedule | undefined,
) {
  if (!schedule?.messageId) return;

  try {
    await ctx.telegram.editMessageText(
      schedule.groupChatId,
      schedule.messageId,
      undefined,
      closedScheduleText(schedule),
    );
  } catch (error) {
    console.error("Failed to close schedule message", error);
  }
}

function participantsLabel(slot: Slot) {
  return [...slot.bookings.values()].map((user) => user.name).join(", ");
}

function hasBookableSlots(schedule: Schedule, dateKey: string) {
  return schedule.slots.some((slot) => slot.dateKey === dateKey);
}

function getActiveSchedule() {
  return activeScheduleId ? schedules.get(activeScheduleId) : undefined;
}

function isActiveSchedule(schedule: Schedule) {
  return schedule.id === activeScheduleId;
}

function getUserBookings(schedule: Schedule, userId: number) {
  return schedule.slots
    .filter((slot) => slot.bookings.has(userId))
    .sort((first, second) => {
      const dateCompare = first.dateKey.localeCompare(second.dateKey);
      return dateCompare || compareTimes(first.time, second.time);
    });
}

function ensureDateTimes(draft: Draft, dateKey: string) {
  const existing = draft.timesByDate.get(dateKey);
  if (existing) return existing;

  const times = new Set<string>();
  draft.timesByDate.set(dateKey, times);
  return times;
}

function isDraftDate(draft: Draft, dateKey: string) {
  return weekDateKeys(draft.weekStart).includes(dateKey);
}

function ensurePrivateTrainer(ctx: BotContext) {
  if (!ctx.from) return false;

  if (ctx.chat?.type !== "private") {
    void ctx.reply("Создавать расписание можно только в личке с ботом.");
    return false;
  }

  if (!isTrainer(ctx.from.id)) {
    void ctx.reply("Создавать расписание может только тренер.");
    return false;
  }

  return true;
}

function isTrainer(userId: number) {
  return trainerIds.size === 0 || trainerIds.has(userId);
}

async function completePendingBooking(
  ctx: BotContext,
  pending: PendingNameRequest,
  name: string,
) {
  if (!ctx.from || !pending.scheduleId || !pending.slotId) {
    await ctx.reply(`Имя сохранено: ${name}`);
    return;
  }

  const schedule = schedules.get(pending.scheduleId);
  const slot = schedule?.slots.find((candidate) => candidate.id === pending.slotId);

  if (!schedule || !slot) {
    await ctx.reply(
      `Имя сохранено: ${name}\nНо выбранное расписание уже недоступно.`,
    );
    return;
  }

  if (!isActiveSchedule(schedule)) {
    await closePublishedSchedule(ctx, schedule);
    await ctx.reply(
      `Имя сохранено: ${name}\nНо запись по этому расписанию уже закрыта.`,
    );
    return;
  }

  if (slot.bookings.has(ctx.from.id)) {
    await ctx.reply(
      `Имя сохранено: ${name}\nВы уже записаны на ${formatDateShort(
        slot.dateKey,
      )}, ${slot.time}.`,
    );
    return;
  }

  if (slot.bookings.size >= MAX_BOOKINGS_PER_SLOT) {
    await ctx.reply(
      `Имя сохранено: ${name}\nНа ${formatDateShort(slot.dateKey)}, ${
        slot.time
      } мест уже нет.`,
    );
    return;
  }

  slot.bookings.set(ctx.from.id, userFromProfile(ctx, name));
  await updatePublishedSchedule(ctx, schedule);
  await ctx.reply(
    `Имя сохранено: ${name}\nВы записаны: ${formatDateShort(slot.dateKey)}, ${
      slot.time
    }.`,
  );
}

function userFromProfile(ctx: BotContext, name: string): BookingUser {
  const from = ctx.from;
  if (!from) {
    throw new Error("User is required");
  }

  return {
    id: from.id,
    name,
    username: from.username,
  };
}

async function replaceCallbackMessage(
  ctx: CallbackContext,
  text: string,
  markup: ReturnType<typeof Markup.inlineKeyboard>,
) {
  try {
    await ctx.editMessageText(text, markup);
  } catch {
    await ctx.reply(text, markup);
  }
}

function getCallbackData(ctx: CallbackContext) {
  const query = ctx.callbackQuery;
  if (!query) return undefined;

  return "data" in query ? query.data : undefined;
}

function namePromptText() {
  return [
    "Под каким именем вас записать?",
    "",
    "Например: Алена Я, Кристина 2, Полина.",
    "Я сохраню это имя для следующих записей.",
  ].join("\n");
}

function namePromptMarkup() {
  return {
    reply_markup: {
      force_reply: true,
      input_field_placeholder: "Например: Алена Я",
      selective: true,
    },
  } as const;
}

function normalizeDisplayName(value: string) {
  const name = value.replace(/\s+/g, " ").trim();
  if (name.length < 2 || name.length > 30) return undefined;
  return name;
}

function loadUserProfiles() {
  const profiles = new Map<number, UserProfile>();
  if (!existsSync(USER_PROFILES_FILE)) return profiles;

  try {
    const rawProfiles = JSON.parse(readFileSync(USER_PROFILES_FILE, "utf8")) as
      | Record<string, UserProfile>
      | undefined;

    for (const [rawUserId, profile] of Object.entries(rawProfiles ?? {})) {
      const userId = Number(rawUserId);
      if (!Number.isNaN(userId) && profile?.name) {
        profiles.set(userId, profile);
      }
    }
  } catch (error) {
    console.error("Failed to load user profiles", error);
  }

  return profiles;
}

function saveUserProfile(userId: number, name: string) {
  userProfiles.set(userId, {
    name,
    updatedAt: new Date().toISOString(),
  });
  saveUserProfiles();
}

function saveUserProfiles() {
  mkdirSync(dirname(USER_PROFILES_FILE), { recursive: true });
  const profiles = Object.fromEntries(
    [...userProfiles.entries()].map(([userId, profile]) => [
      String(userId),
      profile,
    ]),
  );
  writeFileSync(USER_PROFILES_FILE, `${JSON.stringify(profiles, null, 2)}\n`);
}

function parseNumberList(value?: string) {
  const result = new Set<number>();
  for (const item of value?.split(",") ?? []) {
    const trimmed = item.trim();
    if (!trimmed) continue;

    const parsed = Number(trimmed);
    if (!Number.isNaN(parsed)) {
      result.add(parsed);
    }
  }
  return result;
}

function parseSlotTimes(value?: string) {
  const rawTimes = value?.trim() ? value.split(",") : DEFAULT_SLOT_TIMES;
  const times = rawTimes
    .map((item) => item.trim())
    .filter((item) => /^\d{1,2}:\d{2}$/.test(item))
    .map(normalizeTime);

  return [...new Set(times)].sort(compareTimes);
}

function startOfWeek(date: Date) {
  const result = new Date(date);
  const day = result.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  result.setDate(result.getDate() + diff);
  result.setHours(0, 0, 0, 0);
  return result;
}

function weekDateKeys(weekStart: Date) {
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(weekStart);
    date.setDate(date.getDate() + index);
    return dateKey(date);
  });
}

function availableWeekStarts() {
  const currentWeekStart = startOfWeek(new Date());
  return Array.from({ length: WEEKS_TO_SHOW }, (_, index) => {
    const date = new Date(currentWeekStart);
    date.setDate(date.getDate() + index * 7);
    return date;
  });
}

function dateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateFromKey(key: string) {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function formatDateShort(key: string) {
  const date = dateFromKey(key);
  return `${String(date.getDate()).padStart(2, "0")}.${String(
    date.getMonth() + 1,
  ).padStart(2, "0")}`;
}

function formatDateWithDay(key: string) {
  const date = dateFromKey(key);
  return `${formatDateShort(key)} (${DAY_NAMES[date.getDay()]})`;
}

function dayHeader(key: string) {
  return `☀️ ${formatDateWithDay(key)} 🌿`;
}

function weekRangeLabel(weekStart: Date) {
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);
  return `${formatDateShort(dateKey(weekStart))}-${formatDateShort(
    dateKey(weekEnd),
  )}`;
}

function scheduleRangeLabel(schedule: Schedule) {
  const firstDate = schedule.includedDates[0];
  const lastDate = schedule.includedDates[schedule.includedDates.length - 1];
  if (!firstDate || !lastDate) return "";
  return `${formatDateShort(firstDate)}-${formatDateShort(lastDate)}`;
}

function normalizeTime(value: string) {
  const [hours, minutes] = value.split(":");
  return `${hours.padStart(2, "0")}:${minutes}`;
}

function compareTimes(first: string, second: string) {
  return encodeTime(first).localeCompare(encodeTime(second));
}

function encodeTime(time: string) {
  return time.replace(":", "");
}

function decodeTime(value?: string) {
  if (!value || !/^\d{4}$/.test(value)) return undefined;
  return `${value.slice(0, 2)}:${value.slice(2)}`;
}

function chunk<T>(items: T[], size: number) {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

bot.launch().then(() => {
  console.log("Training schedule bot is running.");
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
