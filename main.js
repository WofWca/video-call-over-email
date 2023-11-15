//@ts-check
// Copy-pasted and modified https://codepen.io/miguelao/pen/qRXrKR

/** @typedef {import('webxdc-types/global')} */

document.addEventListener('DOMContentLoaded', init);

function init() {
  // Keep in mind that the same member could connect from two different devices.
  /** @type {Map<number, ReturnType<typeof setUpNewVideoDisplay>>} */
  const incomingStreams = new Map();
  /** @typedef {string} RoomMemberAddr */
  /** @type {Map<RoomMemberAddr, HTMLElement>} */
  const roomMemberEls = new Map();

  let handledOldMessages = false;
  const handledOldMessagesP = window.webxdc.setUpdateListener(update => {
    // Do nothing until we start receiving messages that arrived after
    // the app was opened.
    // Why? Because it's a prototype.
    if (!handledOldMessages) {
      return;
    }

    switch (update.payload.type) {
      case 'newRoomMember': {
        addSectionForMember(
          update.payload.roomMemberAddr,
          update.payload.roomMemberAddr
        );
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

  function addSectionForMember(roomMemberAddr, roomMemberName) {
    const memberSection = createElementForRoomMember(roomMemberName);
    roomMemberEls.set(roomMemberAddr, memberSection);
    document.getElementById('videos').appendChild(memberSection);
  }

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
    }, '');
  });
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
 * @param {BlobEvent} event
 */
async function serializeData(event) {
  const arrayBuffer = await event.data.arrayBuffer();
  return [...(new Uint8Array(arrayBuffer))];
}
function deserializeData(serializedData) {
  return new Uint8Array(serializedData);
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
  video.play();

  await new Promise(r => {
    mediaSource.addEventListener("sourceopen", r, {
      once: true,
      passive: true,
    });
  })
  const sourceBuffer = mediaSource.addSourceBuffer(mimeType);

  containerElement.appendChild(video);

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
      // I'm not an expert, but this codec seems to be supported by a lot
      // of browsers. Maybe there is a better string.
      mimeType: 'video/webm;codecs=vp8',
    });
    recorder.ondataavailable = (e) => {
      this.onDataAvailable(e);
    }

    // Slightly above the sustained send rate of Delta Chat, so that
    // we never send two chunks of data in the same batch, to work around
    // `appendBuffer()` throwing if it's not done processing the previous
    // chunk.
    const slicePeriodMs = 11 * 1000;
    recorder.start(slicePeriodMs);
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
