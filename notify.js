// ★ OneSignalによるプッシュ通知の共通処理。talkScript.js / appScript.js から import して使う。
//   APIキーは imgbb と同じく Firestore の system_keys/onesignal に保存する:
//     { appId: "OneSignalのApp ID", restApiKey: "OneSignalのREST APIキー" }

let keysCache = null;
let initPromise = null;
let initError = null;      // 直近の初期化エラー（iPhoneではConsoleが見られないので画面に出す用）
let ctx = null;            // { db, userId }（再試行用）

async function loadKeys(db) {
  if (keysCache) return keysCache;
  const snap = await db.collection("system_keys").doc("onesignal").get();
  if (!snap.exists) throw new Error("Firestoreの system_keys/onesignal が見つかりません。");
  const data = snap.data();
  if (!data.appId || !data.restApiKey) throw new Error("system_keys/onesignal に appId / restApiKey がありません。");
  keysCache = data;
  return keysCache;
}

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))
  ]);
}

// ★ ログイン後に1回呼ぶ。OneSignalを初期化し、Firebaseのユーザー名(userId)と端末を紐づける
export function initPush(db, userId) {
  ctx = { db, userId };
  if (initPromise) return initPromise;
  initError = null;
  initPromise = (async () => {
    const { appId } = await loadKeys(db);
    // GitHub Pagesのサブパス公開でも動くよう、現在のページのフォルダをService Workerの範囲にする
    const base = location.pathname.replace(/[^/]*$/, "");
    window.OneSignalDeferred = window.OneSignalDeferred || [];
    const sdkReady = new Promise((resolve, reject) => {
      window.OneSignalDeferred.push(async (OneSignal) => {
        try {
          await OneSignal.init({
            appId,
            serviceWorkerPath: base + "OneSignalSDKWorker.js",
            serviceWorkerParam: { scope: base },
            allowLocalhostAsSecureOrigin: true,
            notifyButton: { enable: false }
          });
          await OneSignal.login(userId);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
    await withTimeout(sdkReady, 20000, "OneSignalの読み込みがタイムアウトしました（SDKが読み込めていない可能性があります）。");
  })().catch((e) => {
    initError = e;
    initPromise = null;   // 次回押したときに再試行できるようにする
    console.warn("プッシュ通知の初期化に失敗:", e);
  });
  return initPromise;
}

// ★ ログアウト前に呼ぶ（この端末に前のユーザー宛の通知が届き続けないようにする）
export async function logoutPush() {
  try {
    window.OneSignalDeferred = window.OneSignalDeferred || [];
    await new Promise((resolve) => {
      window.OneSignalDeferred.push(async (OneSignal) => {
        try { await OneSignal.logout(); } catch (e) { console.warn(e); }
        resolve();
      });
      setTimeout(resolve, 3000); // 初期化されていない場合に固まらないように
    });
  } catch (e) {
    console.warn(e);
  }
}

// ★ 現在の通知許可状態（true/false）
export function isPushEnabled() {
  return typeof Notification !== "undefined" && Notification.permission === "granted";
}

// ★ 「通知をオンにする」ボタンの初期化（talk.html / app.html 共通）
export function setupPushButton(buttonId) {
  const btn = document.getElementById(buttonId);
  if (!btn || btn.dataset.pushBound) return;
  btn.dataset.pushBound = "1";

  const say = async (msg) => {
    if (window.AppDialog) await window.AppDialog.alert(msg);
    else alert(msg);
  };
  const refresh = () => btn.classList.toggle("hidden", isPushEnabled());
  refresh();

  btn.addEventListener("click", async () => {
    if (typeof Notification === "undefined") {
      await say("この環境では通知を利用できません。\niPhoneの場合は、Safariの共有ボタンから「ホーム画面に追加」して、追加したアイコンから開いてください。");
      return;
    }
    if (Notification.permission === "denied") {
      await say("通知がブロックされています。\n端末（またはブラウザ）の設定から、このサイトの通知を許可してください。");
      return;
    }

    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = "設定中...";
    try {
      // ① ユーザー操作の直後に、まずブラウザ標準の許可ダイアログを出す（iOSはこの順序が重要）
      if (Notification.permission !== "granted") {
        const permission = await Notification.requestPermission();
        if (permission !== "granted") {
          await say("通知が許可されませんでした。");
          return;
        }
      }

      // ② OneSignal側の初期化を待ち、この端末を購読状態にする
      if (!initPromise && ctx) initPush(ctx.db, ctx.userId);
      if (initPromise) await initPromise;
      if (initError) throw initError;

      window.OneSignalDeferred = window.OneSignalDeferred || [];
      const result = await withTimeout(new Promise((resolve, reject) => {
        window.OneSignalDeferred.push(async (OneSignal) => {
          try {
            await OneSignal.User.PushSubscription.optIn();
            resolve({
              optedIn: OneSignal.User.PushSubscription.optedIn,
              id: OneSignal.User.PushSubscription.id
            });
          } catch (e) {
            reject(e);
          }
        });
      }), 15000, "購読の登録がタイムアウトしました。");

      refresh();
      await say(result.optedIn
        ? "通知をオンにしました。"
        : "許可はされましたが、購読の登録が完了していません。少し待ってからもう一度お試しください。");
    } catch (e) {
      console.error(e);
      await say("通知の設定に失敗しました。\n\n" + (e && e.message ? e.message : String(e)));
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  });
}

// ★ 新着メッセージを、ルームのメンバー（送信者本人を除く）へ通知する。
//   失敗してもメッセージ送信自体には影響させない（エラーは握りつぶす）
export async function sendMessageNotification(db, { roomId, roomTitle, memberIds, senderId, senderName, text }) {
  try {
    const targets = (memberIds || []).filter((id) => id && id !== senderId);
    if (targets.length === 0) return;

    const { appId, restApiKey } = await loadKeys(db);
    const body = (text || "").replace(/\s+/g, " ").trim().slice(0, 80) || "メッセージが届きました";
    const url = new URL(`talk.html?id=${encodeURIComponent(roomId)}`, location.href).href;

    const res = await fetch("https://api.onesignal.com/notifications", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Authorization": `Key ${restApiKey}`
      },
      body: JSON.stringify({
        app_id: appId,
        target_channel: "push",
        include_aliases: { external_id: targets },
        headings: { en: roomTitle || "新着メッセージ", ja: roomTitle || "新着メッセージ" },
        contents: { en: `${senderName}: ${body}`, ja: `${senderName}: ${body}` },
        web_push_topic: roomId,   // 同じルームの通知は最新1件にまとまる
        url
      })
    });
    if (!res.ok) console.warn("通知送信エラー:", res.status, await res.text());
  } catch (e) {
    console.warn("通知送信に失敗（CORSの可能性あり）:", e);
  }
}
