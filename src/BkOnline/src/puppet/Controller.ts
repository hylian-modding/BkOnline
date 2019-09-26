import IMemory from 'modloader64_api/IMemory';

export const enum CMD {
  EMPTY = 0x00000000,
  SPAWN = 0xffffffff,
  DESPAWN = 0xfffffffe,
}

export class Slot {
  private readonly emu: IMemory;
  private readonly addr: number;
  callback: Function = () => {};
  ticking = false;

  constructor(emu: IMemory, addr: number) {
    this.emu = emu;
    this.addr = addr;
  }

  get cmd(): CMD {
    return this.emu.rdramRead32(this.addr);
  }
  set cmd(command: CMD) {
    let exists = this.ptr !== 0x000000;
    if (
      (exists && command === CMD.SPAWN) ||
      (!exists && command === CMD.DESPAWN)
    ) {
      this.emu.rdramWrite32(this.addr, CMD.EMPTY);
    } else {
      this.emu.rdramWrite32(this.addr, command);
    }
  }

  get ptr(): number {
    return this.emu.dereferencePointer(this.addr + 0x04);
  }
}

export class CommandBuffer {
  private readonly cmd_count = global.ModLoader['BK:puppet_address'];
  private readonly slots: Slot[] = new Array<Slot>(16);

  constructor(emu: IMemory) {
    let addr = this.cmd_count + 0x04;
    let offset: number;
    for (let i = 0; i < 16; i++) {
      offset = addr + i * 0x08;
      this.slots[i] = new Slot(emu, offset);
    }
  }
  
  runCommand(
    command: CMD,
    index: number,
    callback: Function = () => {}
  ) {
    if (
      command === CMD.EMPTY || 
      command === this.slots[index].cmd
    ) return;

    this.slots[index].cmd = command;
    this.slots[index].callback = callback;
    this.slots[index].ticking = true;
  }

  onTick() {
    for (let i = 0; i < this.slots.length; i++) {
      if (!this.slots[i].ticking || this.slots[i].cmd !== CMD.EMPTY) continue;

      // command is finished.
      this.slots[i].callback(this.slots[i].ptr);
      this.slots[i].ticking = false;
    }
  }
}
