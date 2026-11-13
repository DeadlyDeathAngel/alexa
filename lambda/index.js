'use strict';

const Alexa = require('ask-sdk-core');
const { getRequestType, getIntentName } = Alexa;

const https = require('https');

const STATIONS_URL =
  process.env.STATIONS_API_URL ||
  'https://broadcasturself.com/api/stations.php';

const LIVE_ONLY = process.env.STATIONS_LIVE_ONLY !== '0';

function httpsGetJson(urlString) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      urlString,
      { headers: { 'User-Agent': 'BroadcastUrself-Alexa/1.0' } },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`Stations API HTTP ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(12000, () => {
      req.destroy();
      reject(new Error('Stations API timeout'));
    });
  });
}

async function fetchStations() {
  const url = LIVE_ONLY
    ? STATIONS_URL + (STATIONS_URL.includes('?') ? '&' : '?') + 'liveOnly=1'
    : STATIONS_URL;
  const data = await httpsGetJson(url);
  if (!data.success || !Array.isArray(data.stations)) {
    throw new Error('Invalid stations payload');
  }
  return data.stations;
}

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findStation(stations, spokenName) {
  const needle = normalizeName(spokenName);
  if (!needle) {
    return null;
  }

  let best = null;
  let bestScore = 0;
  for (const station of stations) {
    const candidates = [
      station.code,
      station.displayName,
      ...(station.nameVariants || []),
    ];
    for (const candidate of candidates) {
      const hay = normalizeName(candidate);
      if (!hay) continue;
      if (hay === needle) {
        return station;
      }
      if (hay.includes(needle) || needle.includes(hay)) {
        const score = Math.min(hay.length, needle.length);
        if (score > bestScore) {
          bestScore = score;
          best = station;
        }
      }
    }
  }
  return best;
}

function speak(text, ssml = false) {
  return ssml
    ? `<speak>${text}</speak>`
    : text;
}

function audioPlayResponse(handlerInput, station) {
  const token = `station-${station.code}`;
  const attributes = handlerInput.attributesManager.getSessionAttributes();
  attributes.playingStationCode = station.code;
  attributes.playingStationName = station.displayName;
  attributes.playingStreamUrl = station.streamUrl;
  attributes.nowPlaying = station.nowPlaying;
  handlerInput.attributesManager.setSessionAttributes(attributes);

  return handlerInput.responseBuilder
    .speak(
      station.isLive
        ? `Playing ${station.displayName}. ${station.nowPlaying !== 'Offline' ? 'Now playing ' + station.nowPlaying : ''}`
        : `${station.displayName} looks offline right now, but I will try the stream.`
    )
    .addAudioPlayerPlayDirective(
      'REPLACE_ALL',
      station.streamUrl,
      token,
      undefined,
      0
    )
    .withShouldEndSession(true)
    .getResponse();
}

const LaunchRequestHandler = {
  canHandle(handlerInput) {
    return getRequestType(handlerInput.requestEnvelope) === 'LaunchRequest';
  },
  handle(handlerInput) {
    return handlerInput.responseBuilder
      .speak(
        'Welcome to Broadcast Urself. Say list stations, play a station name, or what is playing.'
      )
      .reprompt('Which station would you like to hear?')
      .getResponse();
  },
};

const ListStationsIntentHandler = {
  canHandle(handlerInput) {
    return (
      getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
      getIntentName(handlerInput.requestEnvelope) === 'ListStationsIntent'
    );
  },
  async handle(handlerInput) {
    try {
      const stations = await fetchStations();
      if (stations.length === 0) {
        return handlerInput.responseBuilder
          .speak('No stations are live right now. Try again later.')
          .getResponse();
      }
      const live = stations.filter((s) => s.isLive);
      const names = (live.length ? live : stations)
        .slice(0, 8)
        .map((s) => s.displayName)
        .join(', ');
      const more =
        stations.length > 8
          ? ` and ${stations.length - 8} more.`
          : '.';
      return handlerInput.responseBuilder
        .speak(`Here are some stations: ${names}${more}`)
        .reprompt('Say play and a station name to listen.')
        .getResponse();
    } catch (err) {
      console.error(err);
      return handlerInput.responseBuilder
        .speak('I could not reach the station list. Please try again in a moment.')
        .getResponse();
    }
  },
};

const PlayStationIntentHandler = {
  canHandle(handlerInput) {
    return (
      getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
      getIntentName(handlerInput.requestEnvelope) === 'PlayStationIntent'
    );
  },
  async handle(handlerInput) {
    const slots = handlerInput.requestEnvelope.request.intent.slots || {};
    const spoken =
      (slots.StationName && slots.StationName.value) ||
      (slots.StationQuery && slots.StationQuery.value) ||
      '';
    if (!spoken) {
      return handlerInput.responseBuilder
        .speak('Which station should I play?')
        .reprompt('Try saying play and the station name.')
        .getResponse();
    }
    try {
      const stations = await fetchStations();
      const station = findStation(stations, spoken);
      if (!station) {
        return handlerInput.responseBuilder
          .speak(`I could not find a station matching ${spoken}. Say list stations to hear options.`)
          .reprompt('Which station would you like?')
          .getResponse();
      }
      return audioPlayResponse(handlerInput, station);
    } catch (err) {
      console.error(err);
      return handlerInput.responseBuilder
        .speak('Something went wrong starting playback. Please try again.')
        .getResponse();
    }
  },
};

const WhatsPlayingIntentHandler = {
  canHandle(handlerInput) {
    return (
      getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
      getIntentName(handlerInput.requestEnvelope) === 'WhatsPlayingIntent'
    );
  },
  async handle(handlerInput) {
    const attrs = handlerInput.attributesManager.getSessionAttributes();
    if (attrs.playingStationName) {
      const np = attrs.nowPlaying || 'something live';
      return handlerInput.responseBuilder
        .speak(`On ${attrs.playingStationName}, ${np}.`)
        .getResponse();
    }
    try {
      const stations = await fetchStations();
      const live = stations.filter((s) => s.isLive);
      if (live.length === 0) {
        return handlerInput.responseBuilder
          .speak('Nothing is live on the network right now.')
          .getResponse();
      }
      const summary = live
        .slice(0, 3)
        .map((s) => `${s.displayName}: ${s.nowPlaying}`)
        .join('. ');
      return handlerInput.responseBuilder
        .speak(`Across the network. ${summary}`)
        .getResponse();
    } catch (err) {
      console.error(err);
      return handlerInput.responseBuilder
        .speak('I could not check now playing right now.')
        .getResponse();
    }
  },
};

const HelpIntentHandler = {
  canHandle(handlerInput) {
    return (
      getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
      getIntentName(handlerInput.requestEnvelope) === 'AMAZON.HelpIntent'
    );
  },
  handle(handlerInput) {
    return handlerInput.responseBuilder
      .speak(
        'You can say list stations, play followed by a station name, what is playing, pause, or stop.'
      )
      .reprompt('What would you like to do?')
      .getResponse();
  },
};

const StopCancelIntentHandler = {
  canHandle(handlerInput) {
    const type = getRequestType(handlerInput.requestEnvelope);
    if (type !== 'IntentRequest') {
      return false;
    }
    const name = getIntentName(handlerInput.requestEnvelope);
    return name === 'AMAZON.StopIntent' || name === 'AMAZON.CancelIntent';
  },
  handle(handlerInput) {
    return handlerInput.responseBuilder
      .speak('Okay.')
      .addAudioPlayerStopDirective()
      .withShouldEndSession(true)
      .getResponse();
  },
};

const PauseResumeIntentHandler = {
  canHandle(handlerInput) {
    const type = getRequestType(handlerInput.requestEnvelope);
    if (type !== 'IntentRequest') {
      return false;
    }
    const name = getIntentName(handlerInput.requestEnvelope);
    return name === 'AMAZON.PauseIntent' || name === 'AMAZON.ResumeIntent';
  },
  handle(handlerInput) {
    const name = getIntentName(handlerInput.requestEnvelope);
    const response = handlerInput.responseBuilder;
    if (name === 'AMAZON.PauseIntent') {
      return response.speak('Paused.').addAudioPlayerStopDirective().getResponse();
    }
    const attrs = handlerInput.attributesManager.getSessionAttributes();
    if (!attrs.playingStreamUrl) {
      return response.speak('Nothing is playing right now.').getResponse();
    }
    return response
      .speak('Resuming.')
      .addAudioPlayerPlayDirective(
        'REPLACE_ALL',
        attrs.playingStreamUrl,
        `station-${attrs.playingStationCode || 'resume'}`,
        undefined,
        0
      )
      .withShouldEndSession(true)
      .getResponse();
  },
};

const AudioPlayerEventHandler = {
  canHandle(handlerInput) {
    return (
      getRequestType(handlerInput.requestEnvelope).startsWith('AudioPlayer.')
    );
  },
  handle(handlerInput) {
    return handlerInput.responseBuilder.getResponse();
  },
};

const SessionEndedRequestHandler = {
  canHandle(handlerInput) {
    return getRequestType(handlerInput.requestEnvelope) === 'SessionEndedRequest';
  },
  handle(handlerInput) {
    console.log('Session ended', handlerInput.requestEnvelope.request.reason);
    return handlerInput.responseBuilder.getResponse();
  },
};

const ErrorHandler = {
  canHandle() {
    return true;
  },
  handle(handlerInput, error) {
    console.error(error);
    return handlerInput.responseBuilder
      .speak('Sorry, something went wrong. Please try again.')
      .getResponse();
  },
};

exports.handler = Alexa.SkillBuilders.custom()
  .addRequestHandlers(
    LaunchRequestHandler,
    ListStationsIntentHandler,
    PlayStationIntentHandler,
    WhatsPlayingIntentHandler,
    HelpIntentHandler,
    StopCancelIntentHandler,
    PauseResumeIntentHandler,
    AudioPlayerEventHandler,
    SessionEndedRequestHandler
  )
  .addErrorHandlers(ErrorHandler)
  .withCustomUserAgent('broadcast-urself-alexa/1.0')
  .lambda();
