
import * as binary from 'lib0/binary.js'
import * as decoding from 'lib0/decoding.js'
import * as encoding from 'lib0/encoding.js'
import {
  createID,
  readItemContent,
  readDeleteSet,
  writeDeleteSet,
  Skip,
  mergeDeleteSets,
  Item, GC, AbstractUpdateDecoder, UpdateDecoderV1, UpdateDecoderV2, UpdateEncoderV1, UpdateEncoderV2 // eslint-disable-line
} from '../internals.js'

/**
 * @param {AbstractUpdateDecoder} decoder
 */
function * lazyStructReaderGenerator (decoder) {
  const numOfStateUpdates = decoding.readVarUint(decoder.restDecoder)
  for (let i = 0; i < numOfStateUpdates; i++) {
    const numberOfStructs = decoding.readVarUint(decoder.restDecoder)
    const client = decoder.readClient()
    let clock = decoding.readVarUint(decoder.restDecoder)
    for (let i = 0; i < numberOfStructs; i++) {
      const info = decoder.readInfo()
      // @todo use switch instead of ifs
      if (info === 10) {
        const len = decoder.readLen()
        yield new Skip(createID(client, clock), len)
        clock += len
      } else if ((binary.BITS5 & info) !== 0) {
        const cantCopyParentInfo = (info & (binary.BIT7 | binary.BIT8)) === 0
        // If parent = null and neither left nor right are defined, then we know that `parent` is child of `y`
        // and we read the next string as parentYKey.
        // It indicates how we store/retrieve parent from `y.share`
        // @type {string|null}
        const struct = new Item(
          createID(client, clock),
          null, // left
          (info & binary.BIT8) === binary.BIT8 ? decoder.readLeftID() : null, // origin
          null, // right
          (info & binary.BIT7) === binary.BIT7 ? decoder.readRightID() : null, // right origin
          // @ts-ignore Force writing a string here.
          cantCopyParentInfo ? (decoder.readParentInfo() ? decoder.readString() : decoder.readLeftID()) : null, // parent
          cantCopyParentInfo && (info & binary.BIT6) === binary.BIT6 ? decoder.readString() : null, // parentSub
          readItemContent(decoder, info) // item content
        )
        yield struct
        clock += struct.length
      } else {
        const len = decoder.readLen()
        yield new GC(createID(client, clock), len)
        clock += len
      }
    }
  }
}

export class LazyStructReader {
  /**
   * @param {AbstractUpdateDecoder} decoder
   */
  constructor (decoder) {
    this.gen = lazyStructReaderGenerator(decoder)
    /**
     * @type {null | Item | GC}
     */
    this.curr = null
    this.done = false
    this.next()
  }

  /**
   * @return {Item | GC | null}
   */
  next () {
    // ignore "Skip" structs
    do {
      this.curr = this.gen.next().value || null
    } while (this.curr !== null && this.curr.constructor === Skip)
    return this.curr
  }
}

export class LazyStructWriter {
  /**
   * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
   */
  constructor (encoder) {
    this.currClient = 0
    this.startClock = 0
    this.written = 0
    this.encoder = encoder
    /**
     * We want to write operations lazily, but also we need to know beforehand how many operations we want to write for each client.
     *
     * This kind of meta-information (#clients, #structs-per-client-written) is written to the restEncoder.
     *
     * We fragment the restEncoder and store a slice of it per-client until we know how many clients there are.
     * When we flush (toUint8Array) we write the restEncoder using the fragments and the meta-information.
     *
     * @type {Array<{ written: number, restEncoder: Uint8Array }>}
     */
    this.clientStructs = []
  }
}

/**
 * @param {Array<Uint8Array>} updates
 * @return {Uint8Array}
 */
export const mergeUpdates = updates => mergeUpdatesV2(updates, UpdateDecoderV1, UpdateEncoderV1)

/**
 * This method is intended to slice any kind of struct and retrieve the right part.
 * It does not handle side-effects, so it should only be used by the lazy-encoder.
 *
 * @param {Item | GC | Skip} left
 * @param {number} diff
 * @return {Item | GC}
 */
const sliceStruct = (left, diff) => {
  if (left.constructor === GC) {
    const { client, clock } = left.id
    return new GC(createID(client, clock + diff), left.length - diff)
  } else if (left.constructor === Skip) {
    const { client, clock } = left.id
    return new Skip(createID(client, clock + diff), left.length - diff)
  } else {
    const leftItem = /** @type {Item} */ (left)
    const { client, clock } = leftItem.id
    return new Item(
      createID(client, clock + diff),
      null,
      createID(client, clock + diff - 1),
      null,
      leftItem.rightOrigin,
      leftItem.parent,
      leftItem.parentSub,
      leftItem.content.splice(diff)
    )
  }
}

/**
 *
 * This function works similarly to `readUpdateV2`.
 *
 * @param {Array<Uint8Array>} updates
 * @param {typeof UpdateDecoderV1 | typeof UpdateDecoderV2} [YDecoder]
 * @param {typeof UpdateEncoderV1 | typeof UpdateEncoderV2} [YEncoder]
 * @return {Uint8Array}
 */
export const mergeUpdatesV2 = (updates, YDecoder = UpdateDecoderV2, YEncoder = UpdateEncoderV2) => {
  const updateDecoders = updates.map(update => new UpdateDecoderV1(decoding.createDecoder(update)))
  let lazyStructDecoders = updateDecoders.map(decoder => new LazyStructReader(decoder))

  /**
   * @todo we don't need offset because we always slice before
   * @type {null | { struct: Item | GC | Skip, offset: number }}
   */
  let currWrite = null

  const updateEncoder = new YEncoder()
  // write structs lazily
  const lazyStructEncoder = new LazyStructWriter(updateEncoder)

  // Note: We need to ensure that all lazyStructDecoders are fully consumed
  // Note: Should merge document updates whenever possible - even from different updates
  // Note: Should handle that some operations cannot be applied yet ()

  while (true) {
    // Write higher clients first ⇒ sort by clientID & clock and remove decoders without content
    lazyStructDecoders = lazyStructDecoders.filter(dec => dec.curr !== null)
    lazyStructDecoders.sort(
      /** @type {function(any,any):number} */ (dec1, dec2) => {
        if (dec1.curr.id.client === dec2.curr.id.client) {
          const clockDiff = dec1.curr.id.clock - dec2.curr.id.clock
          if (clockDiff === 0) {
            return dec1.curr.constructor === dec2.curr.constructor ? 0 : (
              dec1.curr.constructor === Skip ? 1 : -1
            )
          } else {
            return clockDiff
          }
        } else {
          return dec2.curr.id.client - dec1.curr.id.client
        }
      }
    )
    if (lazyStructDecoders.length === 0) {
      break
    }
    const currDecoder = lazyStructDecoders[0]
    // write from currDecoder until the next operation is from another client or if filler-struct
    // then we need to reorder the decoders and find the next operation to write
    const firstClient = /** @type {Item | GC} */ (currDecoder.curr).id.client
    if (currWrite !== null) {
      let curr = /** @type {Item | GC} */ (currDecoder.curr)
      if (firstClient !== currWrite.struct.id.client) {
        writeStructToLazyStructWriter(lazyStructEncoder, currWrite.struct, currWrite.offset)
        currWrite = { struct: curr, offset: 0 }
        currDecoder.next()
      } else if (currWrite.struct.id.clock + currWrite.struct.length < curr.id.clock) {
        // @todo write currStruct & set currStruct = Skip(clock = currStruct.id.clock + currStruct.length, length = curr.id.clock - self.clock)
        if (currWrite.struct.constructor === Skip) {
          // extend existing skip
          currWrite.struct.length = curr.id.clock + curr.length - currWrite.struct.id.clock
        } else {
          writeStructToLazyStructWriter(lazyStructEncoder, currWrite.struct, currWrite.offset)
          const diff = curr.id.clock - currWrite.struct.id.clock - currWrite.struct.length
          /**
           * @type {Skip}
           */
          const struct = new Skip(createID(firstClient, currWrite.struct.id.clock + currWrite.struct.length), diff)
          currWrite = { struct, offset: 0 }
        }
      } else if (currWrite.struct.id.clock + currWrite.struct.length >= curr.id.clock) {
        const diff = currWrite.struct.id.clock + currWrite.struct.length - curr.id.clock
        if (diff > 0) {
          if (currWrite.struct.constructor === Skip) {
            // prefer to slice Skip because the other struct might contain more information
            currWrite.struct.length -= diff
          } else {
            curr = sliceStruct(curr, diff)
          }
        }
        if (!currWrite.struct.mergeWith(/** @type {any} */ (curr))) {
          writeStructToLazyStructWriter(lazyStructEncoder, currWrite.struct, currWrite.offset)
          currWrite = { struct: curr, offset: 0 }
          currDecoder.next()
        }
      }
    } else {
      currWrite = { struct: /** @type {Item | GC} */ (currDecoder.curr), offset: 0 }
      currDecoder.next()
    }
    for (
      let next = currDecoder.curr;
      next !== null && next.id.client === firstClient && next.id.clock === currWrite.struct.id.clock + currWrite.struct.length && next.constructor !== Skip;
      next = currDecoder.next()
    ) {
      writeStructToLazyStructWriter(lazyStructEncoder, currWrite.struct, currWrite.offset)
      currWrite = { struct: next, offset: 0 }
    }
  }
  if (currWrite !== null) {
    writeStructToLazyStructWriter(lazyStructEncoder, currWrite.struct, currWrite.offset)
    currWrite = null
  }
  finishLazyStructWriting(lazyStructEncoder)

  const dss = updateDecoders.map(decoder => readDeleteSet(decoder))
  const ds = mergeDeleteSets(dss)
  writeDeleteSet(updateEncoder, ds)
  return updateEncoder.toUint8Array()
}

/**
 * @param {Uint8Array} update
 * @param {Uint8Array} sv
 */
export const diffUpdate = (update, sv) => {
  return update
}

/**
 * @param {LazyStructWriter} lazyWriter
 */
const flushLazyStructWriter = lazyWriter => {
  if (lazyWriter.written > 0) {
    lazyWriter.clientStructs.push({ written: lazyWriter.written, restEncoder: encoding.toUint8Array(lazyWriter.encoder.restEncoder) })
    lazyWriter.encoder.restEncoder = encoding.createEncoder()
    lazyWriter.written = 0
  }
}

/**
 * @param {LazyStructWriter} lazyWriter
 * @param {Item | GC} struct
 * @param {number} offset
 */
const writeStructToLazyStructWriter = (lazyWriter, struct, offset) => {
  // flush curr if we start another client
  if (lazyWriter.written > 0 && lazyWriter.currClient !== struct.id.client) {
    flushLazyStructWriter(lazyWriter)
  }
  if (lazyWriter.written === 0) {
    lazyWriter.currClient = struct.id.client
    // write next client
    lazyWriter.encoder.writeClient(struct.id.client)
    // write startClock
    encoding.writeVarUint(lazyWriter.encoder.restEncoder, struct.id.clock)
  }
  struct.write(lazyWriter.encoder, offset)
  lazyWriter.written++
}
/**
 * Call this function when we collected all parts and want to
 * put all the parts together. After calling this method,
 * you can continue using the UpdateEncoder.
 *
 * @param {LazyStructWriter} lazyWriter
 */
const finishLazyStructWriting = (lazyWriter) => {
  flushLazyStructWriter(lazyWriter)

  // this is a fresh encoder because we called flushCurr
  const restEncoder = lazyWriter.encoder.restEncoder

  /**
   * Now we put all the fragments together.
   * This works similarly to `writeClientsStructs`
   */

  // write # states that were updated - i.e. the clients
  encoding.writeVarUint(restEncoder, lazyWriter.clientStructs.length)

  for (let i = 0; i < lazyWriter.clientStructs.length; i++) {
    const partStructs = lazyWriter.clientStructs[i]
    /**
     * Works similarly to `writeStructs`
     */
    // write # encoded structs
    encoding.writeVarUint(restEncoder, partStructs.written)
    // write the rest of the fragment
    encoding.writeUint8Array(restEncoder, partStructs.restEncoder)
  }
}
