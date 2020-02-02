import IMemory from 'modloader64_api/IMemory';
import * as API from 'BanjoKazooie/API/Imports';

export interface IData {
    pointer: number;
    pos: Buffer;
    anim: Buffer;
    rot: Buffer;
    scale: number;
    model: number;
}

export class Data extends API.BaseObj implements IData {
    private readonly copyFields: string[] = new Array<string>();
    player: API.IPlayer;
    pointer: number;
    model_id = 0x00;
    broken = false;

    constructor(emu: IMemory, pointer: number, player: API.IPlayer) {
        super(emu);
        this.pointer = pointer;
        this.player = player;
        this.copyFields.push('anim');
        this.copyFields.push('pos');
        this.copyFields.push('rot');
        this.copyFields.push('model');
        this.copyFields.push('scale');
    }

    safetyCheck(): number {
        let ret = 0x000000;
        if (this.broken) return ret;

        let ptr: number = this.emulator.dereferencePointer(this.pointer);
        if (ptr === 0x000000) {
            this.broken = true;
            return ret;
        }

        if (this.emulator.rdramRead32(ptr + 0x1c) !== 0xdeadbeef) {
            console.log('info:    [DEADBEEF] Saved the day!');
            this.broken = true;
            return ret;
        }

        return ptr;
    }

    get anim(): Buffer {
        return this.player.animation;
    }
    set anim(val: Buffer) {
        let ptr: number = this.safetyCheck();
        if (ptr === 0x000000) return;

        ptr = this.emulator.dereferencePointer(ptr + 0x14);
        if (ptr === 0x000000) {
            this.broken = true;
            return;
        }

        let frame: number = val.readUInt32BE(0);
        let id: number = val.readUInt32BE(4);

        this.emulator.rdramWritePtr32(ptr, 0x14, frame);
        this.emulator.rdramWritePtr32(ptr, 0x10, id);
    }

    get pos(): Buffer {
        return this.player.position;
    }
    set pos(val: Buffer) {
        let ptr: number = this.safetyCheck();
        if (ptr === 0x000000) return;

        this.emulator.rdramWritePtrBuffer(this.pointer, 0x4, val);
    }

    get rot(): Buffer {
        return this.player.rotation;
    }
    set rot(val: Buffer) {
        let ptr: number = this.safetyCheck();
        if (ptr === 0x000000) return;

        let x: number = val.readFloatBE(0x0);
        let y: number = val.readFloatBE(0x4);
        let z: number = val.readFloatBE(0x8);
        this.emulator.rdramWritePtrF32(this.pointer, 0x68, x);
        this.emulator.rdramWritePtrF32(this.pointer, 0x50, y);
        this.emulator.rdramWritePtrF32(this.pointer, 0x110, z);
    }

    get model(): number {
        return this.player.model_index;
    }
    set model(val: number) {
        if (this.model_id === val) return;

        let ptr: number = this.safetyCheck();
        if (ptr === 0x000000) return;

        ptr = this.emulator.dereferencePointer(ptr);
        if (ptr === 0x000000) {
            this.broken = true;
            return;
        }

        let tmp = this.emulator.rdramRead16(ptr + 0x3e);
        tmp &= 0x0003;
        tmp |= val << 2;
        this.emulator.rdramWrite16(ptr + 0x3e, tmp);
    }

    get scale(): number {
        return this.player.scale;
    }

    set scale(val: number) {
        let ptr: number = this.safetyCheck();
        if (ptr === 0x000000) return;

        this.emulator.rdramWrite32(ptr + 0x0128, val);
    }

    toJSON() {
        const jsonObj: any = {};

        for (let i = 0; i < this.copyFields.length; i++) {
            jsonObj[this.copyFields[i]] = (this as any)[this.copyFields[i]];
        }

        return jsonObj;
    }
}
