(function() {
  'use strict';

  function waitForWebpack(callback) {
    const checkInterval = 100;
    const maxAttempts = 100;
    let attempts = 0;

    const check = () => {
      if (attempts >= maxAttempts) {
        console.error('Discord Quest Helper: Failed to load webpack after multiple attempts.');
        return;
      }

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

        if (!webpackRequire || !webpackRequire.c || Object.keys(webpackRequire.c).length < 10) {
          attempts++;
          setTimeout(check, checkInterval);
          return;
        }

        console.debug(`Discord Quest Helper: Webpack loaded with ${Object.keys(webpackRequire.c).length} modules.`);
        callback(webpackRequire);

      } catch (error) {
        console.error('Discord Quest Helper: Error accessing webpack:', error);
        attempts++;
        setTimeout(check, checkInterval);
      }
    };

    check();
  }

  function findModule(webpackRequire, filter) {
    const modules = Object.values(webpackRequire.c);
    for (const module of modules) {
      if (module && module.exports) {
        if (module.exports.Z && filter(module.exports.Z)) return module.exports.Z;
        if (module.exports.ZP && filter(module.exports.ZP)) return module.exports.ZP;
        if (filter(module.exports)) return module.exports;
      }
    }
    return null;
  }

  async function runQuestCode(webpackRequire) {
    try {
      console.info('Discord Quest Helper: Initializing...');

      const userAgent = navigator.userAgent;
      if (userAgent.includes("Electron/")) {
        console.debug('Discord Quest Helper: User-Agent override is active (Electron detected).');
      } else {
        console.warn('Discord Quest Helper: User-Agent does not contain "Electron/". Some quests might fail.');
      }

      const stores = loadStores(webpackRequire);
      if (!stores) return;

      const { QuestsStore, api } = stores;

      if (!QuestsStore.quests || QuestsStore.quests.size === 0) {
        console.log('Discord Quest Helper: No quests found. Please accept a quest first!');
        return;
      }

      const activeQuests = [...QuestsStore.quests.values()].filter(quest => {
        const isExpired = new Date(quest.config.expiresAt).getTime() <= Date.now();
        const isCompleted = !!quest.userStatus?.completedAt;
        const isEnrolled = !!quest.userStatus?.enrolledAt;
        return isEnrolled && !isCompleted && !isExpired;
      });

      if (activeQuests.length === 0) {
        console.info("Discord Quest Helper: You don't have any uncompleted active quests!");
        return;
      }

      console.info(`Discord Quest Helper: Found ${activeQuests.length} active quest(s).`);

      const isDesktopApp = typeof window.DiscordNative !== "undefined";
      if (!isDesktopApp) {
        console.info('Discord Quest Helper: Spoofing Desktop Client via Heartbeat Simulation.');
      }

      await Promise.all(activeQuests.map(quest => processQuest(quest, stores, isDesktopApp)));

      console.info("Discord Quest Helper: All quests processing finished!");

    } catch (error) {
      console.error('Discord Quest Helper: Critical error:', error);
    }
  }

  function loadStores(webpackRequire) {
    try {
      const ApplicationStreamingStore = findModule(webpackRequire, m => m.__proto__?.getStreamerActiveStreamMetadata);
      const RunningGameStore = findModule(webpackRequire, m => m.getRunningGames);
      const QuestsStore = findModule(webpackRequire, m => m.__proto__?.getQuest);
      const ChannelStore = findModule(webpackRequire, m => m.__proto__?.getAllThreadsForParent);
      const GuildChannelStore = findModule(webpackRequire, m => m.getSFWDefaultChannel);
      const FluxDispatcher = findModule(webpackRequire, m => m.__proto__?.flushWaitQueue);
      const api = findModule(webpackRequire, m => m.tn?.get)?.tn;

      if (!ApplicationStreamingStore || !RunningGameStore || !QuestsStore || !ChannelStore || !GuildChannelStore || !FluxDispatcher || !api) {
        const missing = [];
        if (!ApplicationStreamingStore) missing.push('ApplicationStreamingStore');
        if (!RunningGameStore) missing.push('RunningGameStore');
        if (!QuestsStore) missing.push('QuestsStore');
        if (!ChannelStore) missing.push('ChannelStore');
        if (!GuildChannelStore) missing.push('GuildChannelStore');
        if (!FluxDispatcher) missing.push('FluxDispatcher');
        if (!api) missing.push('API');
        throw new Error(`Could not find stores: ${missing.join(', ')}`);
      }

      return { ApplicationStreamingStore, RunningGameStore, QuestsStore, ChannelStore, GuildChannelStore, FluxDispatcher, api };
    } catch (error) {
      console.error('Discord Quest Helper: Error loading stores:', error);
      return null;
    }
  }

  async function processQuest(quest, stores, isDesktopApp) {
    const { api } = stores;
    const questName = quest.config.messages.questName;
    const taskConfig = quest.config.taskConfig ?? quest.config.taskConfigV2;
    
    const taskType = ["WATCH_VIDEO", "PLAY_ON_DESKTOP", "STREAM_ON_DESKTOP", "PLAY_ACTIVITY", "WATCH_VIDEO_ON_MOBILE"]
      .find(type => taskConfig.tasks[type] != null);

    if (!taskType) {
      console.warn(`Discord Quest Helper: Unknown task type for quest "${questName}"`);
      return;
    }

    const taskData = taskConfig.tasks[taskType];
    const secondsNeeded = taskData.target;
    const currentProgress = quest.userStatus?.progress?.[taskType]?.value ?? 0;

    console.info(`Discord Quest Helper: Starting "${questName}" (${taskType}) - Progress: ${currentProgress}/${secondsNeeded}s`);

    if (currentProgress >= secondsNeeded) {
      console.info(`Discord Quest Helper: Quest "${questName}" is already complete.`);
      return;
    }

    try {
      switch (taskType) {
        case "WATCH_VIDEO":
        case "WATCH_VIDEO_ON_MOBILE":
          await handleWatchVideo(quest, api, secondsNeeded, currentProgress);
          break;
        case "PLAY_ON_DESKTOP":
          await handlePlayOnDesktop(quest, stores, isDesktopApp, secondsNeeded, currentProgress);
          break;
        case "STREAM_ON_DESKTOP":
          await handleStreamOnDesktop(quest, stores, isDesktopApp, secondsNeeded, currentProgress);
          break;
        case "PLAY_ACTIVITY":
          await handlePlayActivity(quest, stores, secondsNeeded);
          break;
        default:
          console.warn(`Discord Quest Helper: Unhandled task type ${taskType}`);
      }
    } catch (error) {
      console.error(`Discord Quest Helper: Error processing "${questName}":`, error);
    }
  }

  async function handleWatchVideo(quest, api, secondsNeeded, initialProgress) {
    const questName = quest.config.messages.questName;
    let secondsDone = initialProgress;
    const speed = 30;
    const interval = 5;

    console.info(`Discord Quest Helper: Watching video for "${questName}"...`);

    while (secondsDone < secondsNeeded) {
      secondsDone = Math.min(secondsNeeded, secondsDone + speed);
      
      await new Promise(resolve => setTimeout(resolve, interval * 1000));

      const response = await api.post({
        url: `/quests/${quest.id}/video-progress`,
        body: { timestamp: secondsDone }
      });

      if (response.body.completed_at) {
        console.info(`Discord Quest Helper: Quest "${questName}" completed!`);
        return;
      }
      
      console.debug(`Discord Quest Helper: "${questName}" progress: ${secondsDone}/${secondsNeeded}s`);
    }
  }

  async function handlePlayOnDesktop(quest, stores, isDesktopApp, secondsNeeded, initialProgress) {
    const { RunningGameStore, FluxDispatcher, api } = stores;
    const questName = quest.config.messages.questName;
    const applicationId = quest.config.application.id;

    if (!isDesktopApp) {
      await simulateHeartbeat(quest, api, "PLAY_ON_DESKTOP", secondsNeeded);
      return;
    }

    console.info(`Discord Quest Helper: Spoofing game for "${questName}"...`);
    
    const pid = Math.floor(Math.random() * 10000) * 4 + 1000;
    
    let appName = quest.config.application.name;
    let exeName = "game.exe";
    
    try {
      const appData = await api.get({url: `/applications/public?application_ids=${applicationId}`});
      if (appData.body && appData.body[0]) {
        const app = appData.body[0];
        appName = app.name;
        const winExe = app.executables?.find(x => x.os === "win32");
        if (winExe) exeName = winExe.name.replace(">", "");
      }
    } catch (e) {
      console.warn('Discord Quest Helper: Could not fetch app details, using defaults.');
    }

    const fakeGame = {
      cmdLine: `C:\\Program Files\\${appName}\\${exeName}`,
      exeName: exeName,
      exePath: `c:/program files/${appName.toLowerCase()}/${exeName}`,
      hidden: false,
      isLauncher: false,
      id: applicationId,
      name: appName,
      pid: pid,
      pidPath: [pid],
      processName: appName,
      start: Date.now(),
    };

    const originalGetRunningGames = RunningGameStore.getRunningGames;
    const originalGetGameForPID = RunningGameStore.getGameForPID;
    
    RunningGameStore.getRunningGames = () => [fakeGame];
    RunningGameStore.getGameForPID = (id) => (id === pid ? fakeGame : null);
    
    FluxDispatcher.dispatch({
      type: "RUNNING_GAMES_CHANGE",
      removed: [],
      added: [fakeGame],
      games: [fakeGame]
    });

    await waitForCompletion(stores, quest, "PLAY_ON_DESKTOP", secondsNeeded);

    RunningGameStore.getRunningGames = originalGetRunningGames;
    RunningGameStore.getGameForPID = originalGetGameForPID;
    FluxDispatcher.dispatch({
      type: "RUNNING_GAMES_CHANGE",
      removed: [fakeGame],
      added: [],
      games: []
    });
  }

  async function handleStreamOnDesktop(quest, stores, isDesktopApp, secondsNeeded, initialProgress) {
    const { ApplicationStreamingStore, FluxDispatcher, api } = stores;
    const questName = quest.config.messages.questName;
    const applicationId = quest.config.application.id;

    if (!isDesktopApp) {
      await simulateHeartbeat(quest, api, "STREAM_ON_DESKTOP", secondsNeeded);
      return;
    }

    console.info(`Discord Quest Helper: Spoofing stream for "${questName}"...`);
    console.warn("Discord Quest Helper: NOTE: You must be in a voice channel with at least one other person!");

    const pid = Math.floor(Math.random() * 10000) * 4 + 1000;
    
    const originalGetStreamerActiveStreamMetadata = ApplicationStreamingStore.getStreamerActiveStreamMetadata;
    
    ApplicationStreamingStore.getStreamerActiveStreamMetadata = () => ({
      id: applicationId,
      pid: pid,
      sourceName: null
    });

    await waitForCompletion(stores, quest, "STREAM_ON_DESKTOP", secondsNeeded);

    ApplicationStreamingStore.getStreamerActiveStreamMetadata = originalGetStreamerActiveStreamMetadata;
  }

  async function handlePlayActivity(quest, stores, secondsNeeded) {
    const { ChannelStore, GuildChannelStore, api } = stores;
    const questName = quest.config.messages.questName;

    console.info(`Discord Quest Helper: Simulating activity for "${questName}"...`);

    const privateChannels = ChannelStore.getSortedPrivateChannels();
    let channelId = privateChannels[0]?.id;

    if (!channelId) {
      const guilds = Object.values(GuildChannelStore.getAllGuilds());
      const guildWithVoice = guilds.find(g => g && g.VOCAL && g.VOCAL.length > 0);
      if (guildWithVoice) {
        channelId = guildWithVoice.VOCAL[0].channel.id;
      }
    }

    if (!channelId) {
      console.error('Discord Quest Helper: Could not find a voice channel to simulate activity in.');
      return;
    }

    const streamKey = `call:${channelId}:1`;
    await runHeartbeatLoop(quest, api, streamKey, "PLAY_ACTIVITY", secondsNeeded);
  }

  async function simulateHeartbeat(quest, api, taskName, secondsNeeded) {
    const streamKey = `call:${quest.id}:1`;
    await runHeartbeatLoop(quest, api, streamKey, taskName, secondsNeeded);
  }

  async function runHeartbeatLoop(quest, api, streamKey, taskName, secondsNeeded) {
    const questName = quest.config.messages.questName;
    
    while (true) {
      const response = await api.post({
        url: `/quests/${quest.id}/heartbeat`,
        body: { stream_key: streamKey, terminal: false }
      });

      const progress = response.body.progress[taskName]?.value ?? 0;
      console.debug(`Discord Quest Helper: "${questName}" progress: ${progress}/${secondsNeeded}s`);

      if (progress >= secondsNeeded) {
        await api.post({
          url: `/quests/${quest.id}/heartbeat`,
          body: { stream_key: streamKey, terminal: true }
        });
        console.info(`Discord Quest Helper: Quest "${questName}" completed!`);
        break;
      }

      await new Promise(resolve => setTimeout(resolve, 20 * 1000));
    }
  }

  function waitForCompletion(stores, quest, taskName, secondsNeeded) {
    return new Promise((resolve) => {
      const { FluxDispatcher } = stores;
      const questName = quest.config.messages.questName;

      const progressHandler = (data) => {
        let progress = 0;
        if (data.userStatus?.progress?.[taskName]) {
          progress = Math.floor(data.userStatus.progress[taskName].value);
        } else if (data.userStatus?.streamProgressSeconds) {
          progress = data.userStatus.streamProgressSeconds;
        }

        console.debug(`Discord Quest Helper: "${questName}" progress: ${progress}/${secondsNeeded}s`);

        if (progress >= secondsNeeded) {
          console.info(`Discord Quest Helper: Quest "${questName}" completed!`);
          FluxDispatcher.unsubscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", progressHandler);
          resolve();
        }
      };

      FluxDispatcher.subscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", progressHandler);
    });
  }

  waitForWebpack(runQuestCode);

})();
