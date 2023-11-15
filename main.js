//@ts-check
// Copy-pasted and modified https://codepen.io/miguelao/pen/qRXrKR

/** @typedef {import('webxdc-types/global')} */

document.addEventListener('DOMContentLoaded', init);

function init() {
  /** @type {Map<number, ReturnType<typeof setUpNewVideoDisplay>>} */
  const incomingStreams = new Map();

  let handledOldMessages = false;
  const handledOldMessagesP = window.webxdc.setUpdateListener(update => {
    // Do nothing until we start receiving messages that arrived after
    // the app was opened.
    // Why? Because it's a prototype.
    if (!handledOldMessages) {
      return;
    }

    switch (update.payload.type) {
      case 'newStream': {
        incomingStreams.set(
          update.payload.streamId,
          setUpNewVideoDisplay(update.payload.mimeType)
        );
        break;
      }
      case 'data': {
        const sourceBufferP = incomingStreams.get(update.payload.streamId);
        sourceBufferP.then(sourceBuffer => {
          // TODO fix: if 'data' events are sent often enough, it can so happen
          // that the last `appendBuffer` has not been finished, so this one
          // will throw. Need to check `mediaSource.readyState`.
          const deserializedData = deserializeData(update.payload.data);
          sourceBuffer.appendBuffer(deserializedData);
        })
        break;
      }
      default:
        throw new Error('Unknown message type:' + update.payload.type);
    }
  }, 0);
  handledOldMessagesP.then(() => handledOldMessages = true);

  /** @type {undefined | Awaited<ReturnType<typeof startBroadcast>>} */
  let localStream;
  /** @type {HTMLButtonElement} */
  const startBroadcastButton = document.getElementById('startBroadcast');
  startBroadcastButton.addEventListener('click', () => {
    startBroadcastButton.disabled = true;
    startBroadcast().then(stream => {
      stopBroadcastButton.disabled = false;
      localStream = stream;
    });
  });

  const stopBroadcastButton = document.getElementById('stopBroadcast');
  stopBroadcastButton.addEventListener('click', () => {
    stopBroadcastButton.disabled = true;
    localStream.stop();
    startBroadcastButton.disabled = false;
  });
}

async function startBroadcast() {
  const streamId = Math.random();

  const localStream = new LocalCameraMediaStream(async (event) => {
    const serializedData = await serializeData(event);
    window.webxdc.sendUpdate({
      payload: {
        type: 'data',
        streamId,
        data: serializedData,
      },
      info: `${window.webxdc.selfName} sent a few more frames`,
    }, '');
  });
  await localStream.init();
  window.webxdc.sendUpdate({
    payload: {
      type: 'newStream',
      streamId,
      mimeType: localStream.recorder.mimeType,
    },
    info: `${window.webxdc.selfName} started a broadcast!`,
  }, '');

  return localStream;
}

/**
 * @param {BlobEvent} event
 */
async function serializeData(event) {
  const arrayBuffer = await event.data.arrayBuffer();
  return [...(new Uint8Array(arrayBuffer))];
}
function deserializeData(serializedData) {
  return new Uint8Array(serializedData);
}

async function setUpNewVideoDisplay(mimeType) {
  const mediaSource = new MediaSource();

  const video = document.createElement('video');
  // video.srcObject = mediaSource;
  // TODO revokeObjectURL
  video.src = URL.createObjectURL(mediaSource);
  video.play();

  await new Promise(r => {
    mediaSource.addEventListener("sourceopen", r, {
      once: true,
      passive: true,
    });
  })
  const sourceBuffer = mediaSource.addSourceBuffer(mimeType);

  const videosContainer = document.getElementById('videos');
  videosContainer.appendChild(video);

  // TODO a way to clean up stuff, close `MediaSource`.
  return sourceBuffer;
}

// /**
//  * @typedef {Parameters<
//  *   MediaRecorder['ondataavailable']
//  * >[0]['data']} MediaRecorderData
//  */
/**
 * @typedef {Parameters<
 *   Exclude<MediaRecorder['ondataavailable'], null>
 * >[0]} MediaRecorderDataEvent
 */

class LocalCameraMediaStream {
  /**
   * @param {(data: MediaRecorderDataEvent) => void} onDataAvailable
   */
  constructor(onDataAvailable) {
    /** @type {typeof onDataAvailable} */
    this.onDataAvailable = onDataAvailable;
    this._stopPromise = new Promise(r => this.stop = r);
  }
  async init() {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        // frameRate: {
        //   ideal: 5,
        // },
        height: {
          ideal: 50,
        },
        width: {
          ideal: 50,
        },
      },
      audio: true,
    });
    this._stopPromise.then(() => {
      stream.getTracks().forEach((track) => track.stop() );
    });

    const recorder = this.recorder = new MediaRecorder(stream, {
      bitsPerSecond: 128,
    });
    recorder.ondataavailable = (e) => {
      this.onDataAvailable(e);
    }

    // Slightly below the throttle period of Delta Chat.
    const slicePeriodMs = 5 * 1000;
    recorder.start(slicePeriodMs);
    this._stopPromise.then(() => recorder.stop());

    // if (recorder.state !== 'recording') {
      await new Promise((r) =>
        recorder.addEventListener("start", r, { once: true })
      );
    // }
  }
}