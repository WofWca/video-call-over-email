//@ts-check
// Copy-pasted and modified https://codepen.io/miguelao/pen/qRXrKR

import execWhenSourceBufferReady from './node_modules/when-sourcebuffer-ready/index.js'
/** @typedef {import('@webxdc/types/global')} */

document.addEventListener('DOMContentLoaded', init);

// Slightly above the sustained send rate of Delta Chat,
// a simple workaround.
// If we tried to `sendUpdate()` more often than Delta Chat
// actually sending actual emails, Delta Chat would batch
// these `sendUpdate()` calls into one email.
// But then we'd call `appendBuffer()` twice rapidly, and the second call
// would throw if it's not done processing the previous chunk.
const DATA_SEND_PERIOD =
  1.1 *
  (window.webxdc.sendUpdateInterval != undefined
    ? window.webxdc.sendUpdateInterval
    : 10 * 1000);

function init() {
  document.getElementById('currentOneWayDelay').innerText =
    (DATA_SEND_PERIOD / 1000).toFixed(3);

  // Keep in mind that the same member could connect from two different devices.
  /** @typedef {string} StreamId */
  /** @type {Map<StreamId, ReturnType<typeof setUpNewVideoDisplay>>} */
  const incomingStreams = new Map();
  /** @typedef {string} RoomMemberAddr */
  /** @type {Map<RoomMemberAddr, HTMLElement>} */
  const roomMemberEls = new Map();

  let handledOldMessages = false;
  const handledOldMessagesP = window.webxdc.setUpdateListener(update => {
    // Only handle messages that arrived after the app was opened.
    // Why? Because it's a prototype.
    if (!handledOldMessages) {
      return;
    }

    switch (update.payload.type) {
      case 'newRoomMember': {
        addSectionForMember(
          update.payload.roomMemberAddr,
          update.payload.roomMemberName,
        );

        // Restart the stream, because `appendBuffer` apparently
        // doesn't work if previous buffers are dropped.
        localStreamP
          ?.then(stream => stream.stop())
          .then(() => {
            // IDK if `setTimeout` is needed.
            setTimeout(() => {
              localStreamP = startBroadcast(includeVideoCheckbox.checked)
            })
          })

        break;
      }
      case 'newStream': {
        let containerElement = roomMemberEls.get(update.payload.roomMemberAddr);
        if (!containerElement) {
          addSectionForMember(
            update.payload.roomMemberAddr,
            update.payload.roomMemberAddr // Yes, it should be member name.
          );
          containerElement = roomMemberEls.get(update.payload.roomMemberAddr);
        }

        incomingStreams.set(
          update.payload.streamId,
          setUpNewVideoDisplay(containerElement, update.payload.mimeType)
        );

        // Could be `null` if it's not the first time this member started
        // a stream.
        containerElement.getElementsByClassName('no-video')[0]?.remove();

        break;
      }
      case 'data': {
        const sourceBufferP = incomingStreams.get(update.payload.streamId);
        sourceBufferP.then(async sourceBuffer => {
          // TODO fix: updates can be received out of order,
          // and also a newer `deserializeData` can finish before an older one,
          // which would result in an error if sourceBuffer doesn't support
          // out-of-order `appendBuffer()` operations.
          const deserializedData = await deserializeData(update.payload.data);
          execWhenSourceBufferReady(
            sourceBuffer,
            () => {
              sourceBuffer.appendBuffer(deserializedData)
            }
          );
        })
        break;
      }
      default:
        throw new Error('Unknown message type:' + update.payload.type);
    }
  }, 0);
  handledOldMessagesP.then(() => handledOldMessages = true);

  function addSectionForMember(roomMemberAddr, roomMemberName) {
    const memberSection = createElementForRoomMember(roomMemberName);
    roomMemberEls.set(roomMemberAddr, memberSection);
    document.getElementById('videos').appendChild(memberSection);
  }

  /** @type {undefined | ReturnType<typeof startBroadcast>} */
  let localStreamP;
  /** @type {HTMLButtonElement} */
  const startBroadcastButton = document.getElementById('startBroadcast');
  startBroadcastButton.addEventListener('click', () => {
    startBroadcastButton.disabled = true;
    includeVideoCheckbox.disabled = true;
    localStreamP = startBroadcast(includeVideoCheckbox.checked)
    localStreamP.then(stream => {
      stopBroadcastButton.disabled = false;
    });
  });

  /** @type {HTMLButtonElement} */
  const stopBroadcastButton = document.getElementById('stopBroadcast');
  stopBroadcastButton.addEventListener('click', () => {
    stopBroadcastButton.disabled = true;
    localStreamP?.then(stream => stream.stop());
    localStreamP = undefined;
    startBroadcastButton.disabled = false;
    includeVideoCheckbox.disabled = false;
  });

  /** @type {HTMLInputElement} */
  const includeVideoCheckbox = document.getElementById('includeVideo');

  /** @type {HTMLInputElement} */
  const startOthersStreamsButton = document.getElementById('startOthersStreams');
  startOthersStreamsButton.addEventListener('click', () => {
    for (const video of document.getElementsByTagName('video')) {
      video.play();
      video.currentTime = video.buffered.end(0)
    }
  })

  handledOldMessagesP.then(() => {
    window.webxdc.sendUpdate({
      payload: {
        type: 'newRoomMember',
        roomMemberName: window.webxdc.selfName,
        roomMemberAddr: window.webxdc.selfAddr,
      },
    }, '');
  });
}

function createElementForRoomMember(roomMemberName) {
  const memberSection = document.createElement('section');
  memberSection.classList.add('member')

  const nameEl = document.createElement('h3');
  nameEl.textContent = roomMemberName;
  memberSection.appendChild(nameEl);

  const noVideoYetEl = document.createElement('p');
  noVideoYetEl.classList.add('no-video');
  noVideoYetEl.textContent = 'The member hasn\'t started a broadcast yet';
  memberSection.appendChild(noVideoYetEl);

  return memberSection;
}

/**
 * @param {boolean} includeVideo
 */
async function startBroadcast(includeVideo) {
  const streamId = Math.random();

  const localStream = new LocalCameraMediaStream(
    async (event) => {
      const serializedData = await serializeData(event);
      window.webxdc.sendUpdate({
        payload: {
          type: 'data',
          streamId,
          data: serializedData,
        },
      }, '');
    },
    includeVideo,
  );
  await localStream.init();
  window.webxdc.sendUpdate({
    payload: {
      type: 'newStream',
      roomMemberAddr: window.webxdc.selfAddr,
      streamId,
      mimeType: localStream.recorder.mimeType,
    },
    info: `${window.webxdc.selfName} started a broadcast!`,
  }, '');

  return localStream;
}

/**
 * @param {BlobEvent} onDataAvailableEvent
 */
async function serializeData(onDataAvailableEvent) {
  // const arrayBuffer = await event.data.arrayBuffer();
  // return [...(new Uint8Array(arrayBuffer))];

  const reader = new FileReader();
  return new Promise(r => {
    reader.onload = (fileReaderEvent) => {
      r(fileReaderEvent.target.result);
    }
    reader.readAsDataURL(onDataAvailableEvent.data);
  });
}
async function deserializeData(serializedData) {
  // return new Uint8Array(serializedData);

  // WTF?? If I remove this it stops working? Does `fetch` give different
  // `arrayBuffer` for different `mimeType`?
  const split = serializedData.split(',');
  serializedData =
    "data:application/octet-binary;base64," + split[split.length - 1];

  // Btw, the data URL could be used directly as `video.src`.
  // Actually - no.
  // https://w3c.github.io/mediacapture-record/#mediarecorder-methods :
  // > the individual Blobs need not be playable
  return fetch(serializedData).then(r => r.arrayBuffer());
}

/**
 * @param {HTMLElement} containerElement
 * @param {string} mimeType
 */
async function setUpNewVideoDisplay(containerElement, mimeType) {
  const mediaSource = new MediaSource();

  const video = document.createElement('video');
  // video.srcObject = mediaSource;
  // TODO revokeObjectURL
  video.src = URL.createObjectURL(mediaSource);
  // this fails if the user hasn't interacted with the page (autoplay).
  // That is they won't see the video play.
  // https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/play#usage_notes
  video.play();

  await new Promise(r => {
    mediaSource.addEventListener("sourceopen", r, {
      once: true,
      passive: true,
    });
  })
  const sourceBuffer = mediaSource.addSourceBuffer(mimeType);

  containerElement.appendChild(video);

  // Clean up, don't indefinitely store video data in memory.
  setInterval(() => {
    execWhenSourceBufferReady(sourceBuffer, () => {
      if (sourceBuffer.buffered.length > 1) {
        console.warn(
          "Expected only one buffered range, memory will leak",
          sourceBuffer.buffered
        );
      }
      const toRemoveUpTo = sourceBuffer.buffered.end(0) - 30;
      if (toRemoveUpTo <= 0) {
        return;
      }
      sourceBuffer.remove(0, toRemoveUpTo);
    });
  }, 5000);

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
  constructor(onDataAvailable, includeVideo) {
    this._includeVideo = includeVideo;
    /** @type {typeof onDataAvailable} */
    this.onDataAvailable = onDataAvailable;
    this._stopPromise = new Promise(r => this.stop = r);
  }
  async init() {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: this._includeVideo
        ? {
            // frameRate: {
            //   ideal: 5,
            // },
            height: {
              ideal: 50,
            },
            width: {
              ideal: 50,
            },
          }
        : false,
      audio: true,
    });
    this._stopPromise.then(() => {
      stream.getTracks().forEach((track) => track.stop() );
    });

    const recorder = this.recorder = new MediaRecorder(stream, {
      bitsPerSecond: 128,
      // I'm not an expert, but this codec seems to be supported by a lot
      // of browsers. Maybe there is a better string.
      mimeType: 'video/webm;codecs=vp8',
    });
    recorder.ondataavailable = (e) => {
      this.onDataAvailable(e);
    }

    recorder.start(DATA_SEND_PERIOD);
    this._stopPromise.then(() => recorder.stop());

    // if (recorder.state !== 'recording') {
      await new Promise((r) =>
        recorder.addEventListener("start", r, { once: true })
      );
    // }
  }
}


/**
 * @license
 * Copyright 2023 WofWca <wofwca@protonmail.com>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
