(function() {
  'use strict';

  function waitForWebpack(callback) {
    const checkInterval = 100;
    const maxAttempts = 100;
    let attempts = 0;

    const check = () => {
      if (attempts >= maxAttempts) return;
      if (typeof window.webpackChunkdiscord_app === 'undefined') {
        attempts++;
        setTimeout(check, checkInterval);
        return;
      }

      try {
        const originalJQuery = window.$;
        delete window.$;
        const webpackRequire = window.webpackChunkdiscord_app.push([[Symbol()], {}, (require) => require]);
        window.webpackChunkdiscord_app.pop();
        if (originalJQuery) window.$ = originalJQuery;

        if (!webpackRequire?.c || Object.keys(webpackRequire.c).length < 10) {
          attempts++;
          setTimeout(check, checkInterval);
          return;
        }
        callback(webpackRequire);
      } catch (e) {
        attempts++;
        setTimeout(check, checkInterval);
      }
    };
    check();
  }

  function findModule(webpackRequire, filter) {
    for (const module of Object.values(webpackRequire.c)) {
      if (module?.exports) {
        const exports = module.exports;
        if (exports.A && filter(exports.A)) return exports.A;
        if (exports.Ay && filter(exports.Ay)) return exports.Ay;
        if (exports.ZP && filter(exports.ZP)) return exports.ZP;
        if (filter(exports)) return exports;
      }
    }
    return null;
  }

  function sendUpdate(type, data) {
    window.postMessage({ prefix: 'DISCORD_QUEST_COMPLETER', type, data }, '*');
  }

  async function runQuestCode(webpackRequire) {
    try {
      const version = window.__QUEST_VERSION || 'unknown';
      console.info(`Discord Auto Quest: Initializing v${version}`);

      const stores = loadStores(webpackRequire);
      if (!stores) return;

      const activeQuests = getActiveQuests(stores.QuestsStore);
      if (activeQuests.length === 0) return;

      const questStates = activeQuests.map(q => {
        const taskConfig = q.config.taskConfig ?? q.config.taskConfigV2;
        const taskType = ["WATCH_VIDEO", "PLAY_ON_DESKTOP", "STREAM_ON_DESKTOP", "PLAY_ACTIVITY", "WATCH_VIDEO_ON_MOBILE"].find(t => taskConfig.tasks[t] != null);
        const target = taskConfig.tasks[taskType]?.target ?? 0;
        const progress = q.userStatus?.progress?.[taskType]?.value ?? q.userStatus?.streamProgressSeconds ?? 0;
        
        return {
          quest: q,
          taskType,
          secondsNeeded: target,
          currentProgress: progress,
          completed: progress >= target,
          enrolledAt: new Date(q.userStatus.enrolledAt).getTime(),
          questName: q.config.messages.questName
        };
      });

      sendUpdate('QUEST_LIST', questStates.map(s => ({
        id: s.quest.id,
        name: s.questName,
        progress: Math.floor(s.currentProgress),
        target: s.secondsNeeded,
        completed: s.completed
      })));

      for (const state of questStates) {
        if (state.completed) continue;
        while (!state.completed) {
          if (state.taskType.startsWith("WATCH_VIDEO")) {
            await processVideoStep(state, stores.api);
            if (!state.completed) await new Promise(r => setTimeout(r, 1000));
          } else {
            await processHeartbeatStep(state, stores);
            if (!state.completed) await new Promise(r => setTimeout(r, 30000));
          }
        }
      }
    } catch (e) {}
  }

  function loadStores(webpackRequire) {
    const QuestsStore = findModule(webpackRequire, m => m.__proto__?.getQuest);
    const ChannelStore = findModule(webpackRequire, m => m.__proto__?.getAllThreadsForParent);
    const GuildChannelStore = findModule(webpackRequire, m => m.getSFWDefaultChannel);
    const apiModule = findModule(webpackRequire, m => m.Bo?.get || m.tn?.get);
    const api = apiModule?.Bo || apiModule?.tn || apiModule;

    return (QuestsStore && api) ? { QuestsStore, ChannelStore, GuildChannelStore, api } : null;
  }

  function getActiveQuests(QuestsStore) {
    const supported = ["WATCH_VIDEO", "PLAY_ON_DESKTOP", "STREAM_ON_DESKTOP", "PLAY_ACTIVITY", "WATCH_VIDEO_ON_MOBILE"];
    return [...QuestsStore.quests.values()].filter(q => {
      const taskConfig = q.config.taskConfig ?? q.config.taskConfigV2;
      return q.userStatus?.enrolledAt && !q.userStatus?.completedAt && 
             new Date(q.config.expiresAt).getTime() > Date.now() &&
             supported.some(t => taskConfig.tasks[t] != null);
    });
  }

  async function processVideoStep(state, api) {
    const { quest, secondsNeeded, enrolledAt, currentProgress } = state;
    if (Math.floor((Date.now() - enrolledAt) / 1000) + 10 - currentProgress < 7) return;

    const nextTime = Math.min(secondsNeeded, currentProgress + 7 + Math.random());
    try {
      const res = await api.post({ url: `/quests/${quest.id}/video-progress`, body: { timestamp: nextTime } });
      state.currentProgress = nextTime;
      sendUpdate('QUEST_UPDATE', { id: quest.id, name: state.questName, progress: Math.floor(nextTime), target: secondsNeeded, completed: false });

      if (res.body.completed_at || state.currentProgress >= secondsNeeded) {
        state.completed = true;
        sendUpdate('QUEST_UPDATE', { id: quest.id, name: state.questName, progress: secondsNeeded, target: secondsNeeded, completed: true });
        await api.post({ url: `/quests/${quest.id}/video-progress`, body: { timestamp: secondsNeeded } });
      }
    } catch (e) {}
  }

  async function processHeartbeatStep(state, stores) {
    const { api, ChannelStore, GuildChannelStore } = stores;
    const { quest, taskType, secondsNeeded } = state;

    let cid = ChannelStore?.getSortedPrivateChannels()[0]?.id;
    if (!cid && GuildChannelStore) {
      const v = Object.values(GuildChannelStore.getAllGuilds()).find(g => g?.VOCAL?.length > 0);
      if (v) cid = v.VOCAL[0].channel.id;
    }

    const skey = cid ? `call:${cid}:1` : `call:${quest.id}:1`;
    try {
      const res = await api.post({ url: `/quests/${quest.id}/heartbeat`, body: { stream_key: skey, terminal: false } });
      const p = res.body?.progress?.[taskType]?.value ?? 0;
      state.currentProgress = p;
      sendUpdate('QUEST_UPDATE', { id: quest.id, name: state.questName, progress: Math.floor(p), target: secondsNeeded, completed: p >= secondsNeeded });

      if (p >= secondsNeeded) {
        await api.post({ url: `/quests/${quest.id}/heartbeat`, body: { stream_key: skey, terminal: true } });
        state.completed = true;
      }
    } catch (e) {}
  }

  waitForWebpack(runQuestCode);
})();
