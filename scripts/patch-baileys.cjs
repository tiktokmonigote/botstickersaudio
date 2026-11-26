#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')

const TARGET = path.resolve(
  __dirname,
  '..',
  'node_modules',
  '@whiskeysockets',
  'baileys',
  'WAProto',
  'index.js',
)

const MESSAGE_EDITS = [
  {
    name: 'Message.prototype.audioStickerMessage',
    anchor: '        Message.prototype.pollResultSnapshotMessageV3 = null;\n',
    insert: '        Message.prototype.audioStickerMessage = null;\n',
  },
  {
    name: 'Message.prototype._audioStickerMessage',
    anchor:
      '        Object.defineProperty(Message.prototype, "_pollResultSnapshotMessageV3", {\n' +
      '            get: $util.oneOfGetter($oneOfFields = ["pollResultSnapshotMessageV3"]),\n' +
      '            set: $util.oneOfSetter($oneOfFields)\n' +
      '        });\n',
    insert:
      '\n        // Virtual OneOf for proto3 optional field\n' +
      '        Object.defineProperty(Message.prototype, "_audioStickerMessage", {\n' +
      '            get: $util.oneOfGetter($oneOfFields = ["audioStickerMessage"]),\n' +
      '            set: $util.oneOfSetter($oneOfFields)\n' +
      '        });\n',
  },
  {
    name: 'Message.encode audioStickerMessage',
    anchor:
      '            if (m.pollResultSnapshotMessageV3 != null && Object.hasOwnProperty.call(m, "pollResultSnapshotMessageV3"))\n' +
      '                $root.proto.Message.PollResultSnapshotMessage.encode(m.pollResultSnapshotMessageV3, w.uint32(914).fork()).ldelim();\n',
    insert:
      '            if (m.audioStickerMessage != null && Object.hasOwnProperty.call(m, "audioStickerMessage"))\n' +
      '                $root.proto.Message.FutureProofMessage.encode(m.audioStickerMessage, w.uint32(1074).fork()).ldelim();\n',
  },
  {
    name: 'Message.decode audioStickerMessage',
    anchor:
      '                case 114: {\n' +
      '                        m.pollResultSnapshotMessageV3 = $root.proto.Message.PollResultSnapshotMessage.decode(r, r.uint32());\n' +
      '                        break;\n' +
      '                    }\n',
    insert:
      '                case 134: {\n' +
      '                        m.audioStickerMessage = $root.proto.Message.FutureProofMessage.decode(r, r.uint32());\n' +
      '                        break;\n' +
      '                    }\n',
  },
  {
    name: 'Message.fromObject audioStickerMessage',
    anchor:
      '            if (d.pollResultSnapshotMessageV3 != null) {\n' +
      '                if (typeof d.pollResultSnapshotMessageV3 !== "object")\n' +
      '                    throw TypeError(".proto.Message.pollResultSnapshotMessageV3: object expected");\n' +
      '                m.pollResultSnapshotMessageV3 = $root.proto.Message.PollResultSnapshotMessage.fromObject(d.pollResultSnapshotMessageV3);\n' +
      '            }\n',
    insert:
      '            if (d.audioStickerMessage != null) {\n' +
      '                if (typeof d.audioStickerMessage !== "object")\n' +
      '                    throw TypeError(".proto.Message.audioStickerMessage: object expected");\n' +
      '                m.audioStickerMessage = $root.proto.Message.FutureProofMessage.fromObject(d.audioStickerMessage);\n' +
      '            }\n',
  },
  {
    name: 'Message.toObject audioStickerMessage',
    anchor:
      '            if (m.pollResultSnapshotMessageV3 != null && m.hasOwnProperty("pollResultSnapshotMessageV3")) {\n' +
      '                d.pollResultSnapshotMessageV3 = $root.proto.Message.PollResultSnapshotMessage.toObject(m.pollResultSnapshotMessageV3, o);\n' +
      '                if (o.oneofs)\n' +
      '                    d._pollResultSnapshotMessageV3 = "pollResultSnapshotMessageV3";\n' +
      '            }\n',
    insert:
      '            if (m.audioStickerMessage != null && m.hasOwnProperty("audioStickerMessage")) {\n' +
      '                d.audioStickerMessage = $root.proto.Message.FutureProofMessage.toObject(m.audioStickerMessage, o);\n' +
      '                if (o.oneofs)\n' +
      '                    d._audioStickerMessage = "audioStickerMessage";\n' +
      '            }\n',
  },
]

const STICKER_MESSAGE_EDITS = [
  {
    name: 'StickerMessage.prototype.audioMessage',
    anchor:
      '            StickerMessage.prototype.isLottie = null;\n' +
      '            StickerMessage.prototype.accessibilityLabel = null;\n' +
      '            StickerMessage.prototype.mediaKeyDomain = null;\n',
    insert: '            StickerMessage.prototype.audioMessage = null;\n',
  },
  {
    name: 'StickerMessage.prototype._audioMessage',
    anchor:
      '            Object.defineProperty(StickerMessage.prototype, "_mediaKeyDomain", {\n' +
      '                get: $util.oneOfGetter($oneOfFields = ["mediaKeyDomain"]),\n' +
      '                set: $util.oneOfSetter($oneOfFields)\n' +
      '            });\n',
    insert:
      '\n            // Virtual OneOf for proto3 optional field\n' +
      '            Object.defineProperty(StickerMessage.prototype, "_audioMessage", {\n' +
      '                get: $util.oneOfGetter($oneOfFields = ["audioMessage"]),\n' +
      '                set: $util.oneOfSetter($oneOfFields)\n' +
      '            });\n',
  },
  {
    name: 'StickerMessage.encode audioMessage',
    anchor:
      '                if (m.mediaKeyDomain != null && Object.hasOwnProperty.call(m, "mediaKeyDomain"))\n' +
      '                    w.uint32(184).int32(m.mediaKeyDomain);\n',
    insert:
      '                if (m.audioMessage != null && Object.hasOwnProperty.call(m, "audioMessage"))\n' +
      '                    $root.proto.Message.AudioMessage.encode(m.audioMessage, w.uint32(210).fork()).ldelim();\n',
  },
  {
    name: 'StickerMessage.decode audioMessage',
    anchor:
      '                    case 23: {\n' +
      '                            m.mediaKeyDomain = r.int32();\n' +
      '                            break;\n' +
      '                        }\n',
    insert:
      '                    case 26: {\n' +
      '                            m.audioMessage = $root.proto.Message.AudioMessage.decode(r, r.uint32());\n' +
      '                            break;\n' +
      '                        }\n',
  },
  {
    name: 'StickerMessage.fromObject audioMessage',
    anchor:
      '                case "BOT":\n' +
      '                case 4:\n' +
      '                    m.mediaKeyDomain = 4;\n' +
      '                    break;\n' +
      '                }\n',
    insert:
      '                if (d.audioMessage != null) {\n' +
      '                    if (typeof d.audioMessage !== "object")\n' +
      '                        throw TypeError(".proto.Message.StickerMessage.audioMessage: object expected");\n' +
      '                    m.audioMessage = $root.proto.Message.AudioMessage.fromObject(d.audioMessage);\n' +
      '                }\n',
  },
  {
    name: 'StickerMessage.toObject audioMessage',
    anchor:
      '                if (m.mediaKeyDomain != null && m.hasOwnProperty("mediaKeyDomain")) {\n' +
      '                    d.mediaKeyDomain = o.enums === String ? $root.proto.Message.MediaKeyDomain[m.mediaKeyDomain] === undefined ? m.mediaKeyDomain : $root.proto.Message.MediaKeyDomain[m.mediaKeyDomain] : m.mediaKeyDomain;\n' +
      '                    if (o.oneofs)\n' +
      '                        d._mediaKeyDomain = "mediaKeyDomain";\n' +
      '                }\n',
    insert:
      '                if (m.audioMessage != null && m.hasOwnProperty("audioMessage")) {\n' +
      '                    d.audioMessage = $root.proto.Message.AudioMessage.toObject(m.audioMessage, o);\n' +
      '                    if (o.oneofs)\n' +
      '                        d._audioMessage = "audioMessage";\n' +
      '                }\n',
  },
]

function applyEdits(source, edits) {
  let out = source
  for (const edit of edits) {
    const first = out.indexOf(edit.anchor)
    if (first === -1) {
      throw new Error(`Anchor not found for "${edit.name}". Baileys version may have changed.`)
    }
    const second = out.indexOf(edit.anchor, first + 1)
    if (second !== -1) {
      throw new Error(`Anchor matched multiple times for "${edit.name}". Aborting to avoid corruption.`)
    }
    out = out.slice(0, first + edit.anchor.length) + edit.insert + out.slice(first + edit.anchor.length)
  }
  return out
}

function patchScopedBlock(source, startMarker, endMarker, edits) {
  const start = source.indexOf(startMarker)
  if (start === -1) throw new Error(`Block start marker not found: ${startMarker}`)
  const end = source.indexOf(endMarker, start)
  if (end === -1) throw new Error(`Block end marker not found: ${endMarker}`)

  const blockEnd = end + endMarker.length
  const patchedBlock = applyEdits(source.slice(start, blockEnd), edits)
  return source.slice(0, start) + patchedBlock + source.slice(blockEnd)
}

function verifyRoundTrip() {
  delete require.cache[require.resolve(TARGET)]
  const { proto } = require(TARGET)

  const sample = proto.Message.fromObject({
    audioStickerMessage: {
      message: {
        stickerMessage: {
          mimetype: 'image/webp',
          isAnimated: true,
          width: 512,
          height: 512,
          audioMessage: {
            mimetype: 'audio/ogg; codecs=opus',
            seconds: 4,
          },
        },
      },
    },
  })

  const encoded = proto.Message.encode(sample).finish()
  const decoded = proto.Message.decode(encoded)
  const innerAudio = decoded.audioStickerMessage?.message?.stickerMessage?.audioMessage

  if (!innerAudio || innerAudio.mimetype !== 'audio/ogg; codecs=opus' || innerAudio.seconds !== 4) {
    throw new Error('Protobuf round-trip verification failed for audioStickerMessage / audioMessage')
  }
}

function main() {
  if (!fs.existsSync(TARGET)) {
    console.error(`[patch] Baileys WAProto not found at ${TARGET}. Run "npm install" first.`)
    process.exit(1)
  }

  const original = fs.readFileSync(TARGET, 'utf8')
  const hasField134 = original.includes('Message.prototype.audioStickerMessage')
  const hasField26 = original.includes('StickerMessage.prototype.audioMessage')

  if (hasField134 && hasField26) {
    verifyRoundTrip()
    console.log('[patch] Baileys WAProto already supports audioStickerMessage (134) + audioMessage (26). Verified.')
    return
  }

  let content = original
  if (!hasField134) {
    content = applyEdits(content, MESSAGE_EDITS)
  }
  if (!hasField26) {
    content = patchScopedBlock(
      content,
      'Message.StickerMessage = (function() {',
      'return StickerMessage;\n        })();',
      STICKER_MESSAGE_EDITS,
    )
  }

  fs.writeFileSync(TARGET, content, 'utf8')
  verifyRoundTrip()
  console.log('[patch] Patched Baileys WAProto with audioStickerMessage (134) + StickerMessage.audioMessage (26). Verified.')
}

try {
  main()
} catch (err) {
  console.error('[patch] Failed:', err.message)
  process.exit(1)
}
