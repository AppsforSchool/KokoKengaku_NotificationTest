// ★ OneSignalによるプッシュ通知の共通処理。talkScript.js / appScript.js から import して使う。
//   APIキーは imgbb と同じく Firestore の system_keys/onesignal に保存する:
//     { appId: "OneSignalのApp ID", restApiKey: "OneSignalのREST APIキー" }

let keysCache = null;
let initPromise = null;

async function loadKeys(db) {
  if (keysCache) return keysCache;
  const snap = await db.collection("system_keys").doc("onesignal").get();
  if (!snap.exists) throw new Error("system_keys/onesignal が見つかりません。");
  keysCache = snap.data();
  return keysCache;
}

// ★ ログイン後に1回呼ぶ。OneSignalを初期化し、Firebaseのユーザー名(userId)と端末を紐づける
export function initPush(db, userId) {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const { appId } = await loadKeys(db);
    // GitHub Pagesのサブパス公開でも動くよう、現在のページのフォルダをService Workerの範囲にする
    const base = location.pathname.replace(/[^/]*$/, "");
    window.OneSignalDeferred = window.OneSignalDeferred || [];
    await new Promise((resolve, reject) => {
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
  })().catch((e) => {
    console.warn("プッシュ通知の初期化に失敗:", e);
    initPromise = null;
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

// ★ 「通知をオンにする」ボタン用（ユーザーのタップから呼ぶこと。iOSは必須）
export async function enablePush() {
  window.OneSignalDeferred = window.OneSignalDeferred || [];
  return new Promise((resolve) => {
    window.OneSignalDeferred.push(async (OneSignal) => {
      try {
        await OneSignal.Notifications.requestPermission();
        resolve(OneSignal.Notifications.permission);
      } catch (e) {
        console.warn(e);
        resolve(false);
      }
    });
  });
}

// ★ 現在の通知許可状態（true/false）。初期化前は false
export function isPushEnabled() {
  return typeof Notification !== "undefined" && Notification.permission === "granted";
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

// ★ 「通知をオンにする」ボタンの初期化（talk.html / app.html 共通）
export function setupPushButton(buttonId) {
  const btn = document.getElementById(buttonId);
  if (!btn || btn.dataset.pushBound) return;
  btn.dataset.pushBound = "1";

  const refresh = () => btn.classList.toggle("hidden", isPushEnabled());
  refresh();

  btn.addEventListener("click", async () => {
    const dialog = window.AppDialog;
    if (typeof Notification === "undefined") {
      const msg = "この環境では通知を利用できません。\niPhoneの場合は、Safariの共有ボタンから「ホーム画面に追加」して、追加したアイコンから開いてください。";
      dialog ? await dialog.alert(msg) : alert(msg);
      return;
    }
    if (Notification.permission === "denied") {
      const msg = "通知がブラウザでブロックされています。\nブラウザ（または端末）の設定から、このサイトの通知を許可してください。";
      dialog ? await dialog.alert(msg) : alert(msg);
      return;
    }
    await enablePush();
    refresh();
  });
}
