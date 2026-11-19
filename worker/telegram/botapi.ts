/** Обращения к Telegram Bot API. Токен живёт только здесь, на сервере. */

export type TgResult =
  | { ok: true; result: any }
  | { ok: false; error_code: number; description: string; parameters?: { retry_after?: number } };

export interface TelegramApi {
  call(method: string, params: Record<string, unknown>): Promise<TgResult>;
}

export function realTelegram(token: string | undefined): TelegramApi {
  return {
    async call(method, params) {
      if (!token) return { ok: false, error_code: -1, description: "BOT_TOKEN не задан" };
      try {
        const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(params),
        });
        const data = (await res.json()) as TgResult;
        return data;
      } catch (e) {
        // Сетевая ошибка: без подробностей, чтобы токен или данные не попали в журнал.
        return { ok: false, error_code: 0, description: "network error" };
      }
    },
  };
}

export function webAppButton(text: string, url: string) {
  return { inline_keyboard: [[{ text, web_app: { url } }]] };
}

export function escapeHtml(s: string): string {
  return (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
