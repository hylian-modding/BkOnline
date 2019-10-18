import {
  EventsClient,
  EventServerJoined,
  EventServerLeft,
  EventHandler,
  EventsServer,
} from 'modloader64_api/EventHandler';
import { IModLoaderAPI, IPlugin } from 'modloader64_api/IModLoaderAPI';
import {
  INetworkPlayer,
  LobbyData,
  NetworkHandler,
  ServerNetworkHandler,
} from 'modloader64_api/NetworkHandler';
import { InjectCore } from 'modloader64_api/CoreInjection';
import { Packet } from 'modloader64_api/ModLoaderDefaultImpls';
import * as API from 'modloader64_api/BK/Imports';
import * as Net from './network/Imports';
import * as Puppet from './puppet/Imports';

export class BkOnline implements IPlugin {
  ModLoader = {} as IModLoaderAPI;
  name = 'BkOnline';

  @InjectCore() core!: API.IBKCore;

  // Storage Variables
  cDB = new Net.DatabaseClient();

  // Puppet Handler
  protected pMgr!: Puppet.PuppetManager;

  // Helpers
  protected curLevel: API.LevelType = API.LevelType.UNKNOWN;
  protected curScene: API.SceneType = API.SceneType.UNKNOWN;
  protected actor_arr_addr!: number;
  protected beta_menu_addr!: number;
  protected collision_addr!: number;
  protected level_lookup_addr!: number;
  protected ocollision_addr!: number;
  protected vcollision_addr!: number;
  protected voxel_arr_addr!: number;
  protected voxel_cnt_addr!: number;
  protected maxPuzzleCount = 0;
  protected maxTokensSpent = 0;
  protected oNoteCount = 0;
  protected needDeleteActors = false;
  protected needDeleteVoxels = false;
  protected isRelease = false;
  
  // Temporary handler for documentation
  private eventsL = 0;
  private eventsS = 0;
  read_events() {
    if (this.isRelease) return;
    let evt: number;
    let i: number;
    let isSet: boolean;

    evt = this.core.runtime.current_level_events;
    if (evt !== this.eventsL) {
      for (i = 0; i < 32; i++) {
        isSet = (evt & (1 << i)) !== 0;
        if (((this.eventsL & (1 << i)) !== 0) !== isSet) {
          if (isSet) {
            this.ModLoader.logger.info('Level-Bit Set:' + i);
          } else {
            this.ModLoader.logger.info('Level-Bit Unset:' + i);
          }
        }
      }

      this.eventsL = evt;
    }

    evt = this.core.runtime.current_scene_events;
    if (evt !== this.eventsS) {
      for (i = 0; i < 32; i++) {
        isSet = (evt & (1 << i)) !== 0;
        if (((this.eventsS & (1 << i)) !== 0) !== isSet) {
          if (isSet) {
            this.ModLoader.logger.info('Scene-Bit Set:' + i);
          } else {
            this.ModLoader.logger.info('Scene-Bit Unset:' + i);
          }
        }
      }

      this.eventsS = evt;
    }
  }

  count_flags(buf: Buffer, offset: number, count: number): number {
    let result = 0;
    let byteOff: number;
    let bitOff: number;
    let tOffset: number;

    for (let i = 0; i < count; i++) {
      tOffset = offset + i;
      byteOff = Math.floor(tOffset / 8);
      bitOff = tOffset % 8;

      if (buf[byteOff] & (1 << bitOff)) {
        result |= 1 << i;
      }
    }

    return result;
  }

  set_flags(buf: Buffer, offset: number, count: number, val: number) {
    let byteOff: number;
    let bitOff: number;
    let tOffset: number;

    for (let i = 0; i < count; i++) {
      tOffset = offset + i;
      byteOff = Math.floor(tOffset / 8);
      bitOff = tOffset % 8;

      if ((buf[byteOff] & (1 << bitOff)) !== (val & (1 << i))) {
        buf[byteOff] ^= 1 << bitOff;
      }
    }
  }

  find_level(scene: number): API.LevelType {
    let ptr = this.level_lookup_addr;
    let val = this.ModLoader.emulator.rdramRead16(ptr);
    while(val !== scene){
        ptr += 0x08;
        val = this.ModLoader.emulator.rdramRead16(ptr);
    }
    
    let ret = this.ModLoader.emulator.rdramRead16(ptr + 0x02);
    return ret as API.LevelType;
  }

  check_db_instance(db: Net.Database, level: number, scene: number) {
    if (level === 0) return;
    
    // Spawn missing level variable!
    if (!db.level_data.hasOwnProperty(level)) {
      db.level_data[level] = new Net.LevelData();
    }

    if (scene === 0) return;

    // Spawn missing scene variable!
    if (!db.level_data[level].scene.hasOwnProperty(scene)) {
      db.level_data[level].scene[scene] = new Net.SceneData();
    }
  }

  handle_scene_change(scene: API.SceneType) {
    if (scene === this.curScene) return;

    // Set global to current scene value
    this.curScene = scene;

    // Alert scene change so puppet can despawn for other players
    if (scene === API.SceneType.UNKNOWN) {
      this.ModLoader.clientSide.sendPacket(new Net.SyncLocation(this.ModLoader.clientLobby, 0, 0));
      return;
    }
    
    // Detect new level
    let level = this.find_level(scene);  
    
    // Handle level change stuff
    if (level !== this.curLevel) {   
      this.curLevel = level; 

      // Reset object note count
      this.oNoteCount = 0;
    }

    // Detect if level data broke or wasn't found
    if (level === API.LevelType.UNKNOWN) {
      this.ModLoader.logger.info('[ERROR] -- Level not found!');

    }
        
    // Ensure we have this level/scene data!
    this.check_db_instance(this.cDB, level, scene);  
        
    // Alert scene change!
    this.ModLoader.clientSide.sendPacket(new Net.SyncLocation(this.ModLoader.clientLobby, level, scene));
    this.ModLoader.logger.info('[Tick] Moved to scene[' + API.SceneType[scene] + '].');

    // Remove completed jinjos from previous session!
    if (this.cDB.level_data[level].jinjos !== 0x1f) {
      switch (level) {
        case API.LevelType.MUMBOS_MOUNTAIN:
          if ((this.cDB.jiggy_flags[0] & (1 << 1)) !== 0)
            this.cDB.level_data[level].jinjos = 0x1f;
          break;

        case API.LevelType.TREASURE_TROVE_COVE:
            if ((this.cDB.jiggy_flags[1] & (1 << 3)) !== 0)
              this.cDB.level_data[level].jinjos = 0x1f;
          break;

        case API.LevelType.CLANKERS_CAVERN:
            if ((this.cDB.jiggy_flags[2] & (1 << 5)) !== 0)
              this.cDB.level_data[level].jinjos = 0x1f;
          break;
          
        case API.LevelType.BUBBLE_GLOOP_SWAMP:
            if ((this.cDB.jiggy_flags[3] & (1 << 7)) !== 0)
              this.cDB.level_data[level].jinjos = 0x1f;
          break;

        case API.LevelType.FREEZEEZY_PEAK:
            if ((this.cDB.jiggy_flags[5] & (1 << 1)) !== 0)
              this.cDB.level_data[level].jinjos = 0x1f;
          break;

        case API.LevelType.GOBEYS_VALEY:
            if ((this.cDB.jiggy_flags[7] & (1 << 5)) !== 0)
              this.cDB.level_data[level].jinjos = 0x1f;
          break;

        case API.LevelType.CLICK_CLOCK_WOODS:
            if ((this.cDB.jiggy_flags[8] & (1 << 7)) !== 0)
              this.cDB.level_data[level].jinjos = 0x1f;
          break;

        case API.LevelType.RUSTY_BUCKET_BAY:
            if ((this.cDB.jiggy_flags[10] & (1 << 1)) !== 0)
              this.cDB.level_data[level].jinjos = 0x1f;
          break;

        case API.LevelType.MAD_MONSTER_MANSION:
            if ((this.cDB.jiggy_flags[11] & (1 << 3)) !== 0)
              this.cDB.level_data[level].jinjos = 0x1f;
          break;
      }
    }
    
    // Make sure to delete already collected stuff!
    this.needDeleteActors = true;
    this.needDeleteVoxels = true;

    // temp values
    this.eventsL = 0;
    this.eventsS = 0;
  }

  handle_puppets(scene: API.SceneType, isLoading: boolean, inTransit: boolean) {
    if (isLoading) {
      this.pMgr.set_scene(API.SceneType.UNKNOWN);
    } else {
      this.pMgr.set_scene(scene);
    }

    this.pMgr.onTick(
      !inTransit && !isLoading && this.curScene !== API.SceneType.UNKNOWN
    );
  }

  handle_puzzle_count(bufData: Buffer, bufStorage: Buffer) {
    // Initializers
    let pData: Net.SyncBuffered;
    let i: number;
    let needUpdate = false;

    // Count puzzles currently slotted
    bufStorage = this.cDB.jigsaws_completed;
    let count_mm: number = this.count_flags(
      bufData,
      API.GameBMP.PIECES_IN_PUZZLE_MM_0,
      1
    );
    let count_ttc: number = this.count_flags(
      bufData,
      API.GameBMP.PIECES_IN_PUZZLE_TTC_0,
      2
    );
    let count_cc: number = this.count_flags(
      bufData,
      API.GameBMP.PIECES_IN_PUZZLE_CC_0,
      3
    );
    let count_bgs: number = this.count_flags(
      bufData,
      API.GameBMP.PIECES_IN_PUZZLE_BGS_0,
      3
    );
    let count_fp: number = this.count_flags(
      bufData,
      API.GameBMP.PIECES_IN_PUZZLE_FP_0,
      4
    );
    let count_gv: number = this.count_flags(
      bufData,
      API.GameBMP.PIECES_IN_PUZZLE_GV_0,
      4
    );
    let count_mmm: number = this.count_flags(
      bufData,
      API.GameBMP.PIECES_IN_PUZZLE_MMM_0,
      4
    );
    let count_rbb: number = this.count_flags(
      bufData,
      API.GameBMP.PIECES_IN_PUZZLE_RBB_0,
      4
    );
    let count_ccw: number = this.count_flags(
      bufData,
      API.GameBMP.PIECES_IN_PUZZLE_CCW_0,
      4
    );
    let count_dog: number = this.count_flags(
      bufData,
      API.GameBMP.PIECES_IN_PUZZLE_DOG_0,
      5
    );
    let count_dh: number = this.count_flags(
      bufData,
      API.GameBMP.PIECES_IN_PUZZLE_DH_0,
      3
    );
    needUpdate = false;

    // Handle new completed puzzles
    {
      // Mumbos Mountain
      if (count_mm === 1 && bufStorage[0] !== 1) {
        bufStorage[0] = 1;
        needUpdate = true;
      } else if (count_mm !== 1 && bufStorage[0] === 1) {
        count_mm = 1;
        this.set_flags(bufData, API.GameBMP.PIECES_IN_PUZZLE_MM_0, 1, 1);
        needUpdate = true;
      }

      // Treasure Trove Cove
      if (count_ttc === 2 && bufStorage[1] !== 1) {
        bufStorage[1] = 1;
        needUpdate = true;
      } else if (count_ttc !== 2 && bufStorage[1] === 1) {
        count_ttc = 2;
        this.set_flags(bufData, API.GameBMP.PIECES_IN_PUZZLE_TTC_0, 2, 2);
        needUpdate = true;
      }

      // Clankers Cavern
      if (count_cc === 5 && bufStorage[2] !== 1) {
        bufStorage[2] = 1;
        needUpdate = true;
      } else if (count_cc !== 5 && bufStorage[2] === 1) {
        count_cc = 5;
        this.set_flags(bufData, API.GameBMP.PIECES_IN_PUZZLE_CC_0, 3, 5);
        needUpdate = true;
      }

      // BubbleGloop Swamp
      if (count_bgs === 7 && bufStorage[3] !== 1) {
        bufStorage[3] = 1;
        needUpdate = true;
      } else if (count_bgs !== 7 && bufStorage[3] === 1) {
        count_bgs = 7;
        this.set_flags(bufData, API.GameBMP.PIECES_IN_PUZZLE_BGS_0, 3, 7);
        needUpdate = true;
      }

      // Freezeezy Peaks
      if (count_fp === 8 && bufStorage[4] !== 1) {
        bufStorage[4] = 1;
        needUpdate = true;
      } else if (count_fp !== 8 && bufStorage[4] === 1) {
        count_fp = 8;
        this.set_flags(bufData, API.GameBMP.PIECES_IN_PUZZLE_FP_0, 4, 8);
        needUpdate = true;
      }

      // Gobeys Valley
      if (count_gv === 9 && bufStorage[5] !== 1) {
        bufStorage[5] = 1;
        needUpdate = true;
      } else if (count_gv !== 9 && bufStorage[5] === 1) {
        count_gv = 9;
        this.set_flags(bufData, API.GameBMP.PIECES_IN_PUZZLE_GV_0, 4, 9);
        needUpdate = true;
      }

      // Mad Monster Mansion
      if (count_mmm === 10 && bufStorage[6] !== 1) {
        bufStorage[6] = 1;
        needUpdate = true;
      } else if (count_mmm !== 10 && bufStorage[6] === 1) {
        count_mmm = 10;
        this.set_flags(bufData, API.GameBMP.PIECES_IN_PUZZLE_MMM_0, 4, 10);
        needUpdate = true;
      }

      // Rusty Bucket Bay
      if (count_rbb === 12 && bufStorage[7] !== 1) {
        bufStorage[7] = 1;
        needUpdate = true;
      } else if (count_rbb !== 12 && bufStorage[7] === 1) {
        count_rbb = 12;
        this.set_flags(bufData, API.GameBMP.PIECES_IN_PUZZLE_RBB_0, 4, 12);
        needUpdate = true;
      }

      // Click Clock Woods
      if (count_ccw === 15 && bufStorage[8] !== 1) {
        bufStorage[8] = 1;
        needUpdate = true;
      } else if (count_ccw !== 15 && bufStorage[8] === 1) {
        count_ccw = 15;
        this.set_flags(bufData, API.GameBMP.PIECES_IN_PUZZLE_CCW_0, 4, 15);
        needUpdate = true;
      }

      // Door Of Gruntilda
      if (count_dog === 25 && bufStorage[9] !== 1) {
        bufStorage[9] = 1;
        needUpdate = true;
      } else if (count_dog !== 25 && bufStorage[9] === 1) {
        count_dog = 25;
        this.set_flags(bufData, API.GameBMP.PIECES_IN_PUZZLE_DOG_0, 5, 25);
        needUpdate = true;
      }

      // Defense HoneyComb
      if (count_dh === 4 && bufStorage[10] !== 1) {
        bufStorage[10] = 1;
        needUpdate = true;
      } else if (count_dh !== 4 && bufStorage[10] === 1) {
        count_dh = 4;
        this.set_flags(bufData, API.GameBMP.PIECES_IN_PUZZLE_DH_0, 3, 4);
        needUpdate = true;
      }
    }

    if (needUpdate) {
      if (count_mm !== 1) {
        count_mm = 0;
        this.set_flags(bufData, API.GameBMP.PIECES_IN_PUZZLE_MM_0, 1, 0);
      }
      if (count_ttc !== 2) {
        count_ttc = 0;
        this.set_flags(bufData, API.GameBMP.PIECES_IN_PUZZLE_TTC_0, 2, 0);
      }
      if (count_cc !== 5) {
        count_cc = 0;
        this.set_flags(bufData, API.GameBMP.PIECES_IN_PUZZLE_CC_0, 3, 0);
      }
      if (count_bgs !== 7) {
        count_bgs = 0;
        this.set_flags(bufData, API.GameBMP.PIECES_IN_PUZZLE_BGS_0, 3, 0);
      }
      if (count_fp !== 8) {
        count_fp = 0;
        this.set_flags(bufData, API.GameBMP.PIECES_IN_PUZZLE_FP_0, 4, 0);
      }
      if (count_gv !== 9) {
        count_gv = 0;
        this.set_flags(bufData, API.GameBMP.PIECES_IN_PUZZLE_GV_0, 4, 0);
      }
      if (count_mmm !== 10) {
        count_mmm = 0;
        this.set_flags(bufData, API.GameBMP.PIECES_IN_PUZZLE_MMM_0, 4, 0);
      }
      if (count_rbb !== 12) {
        count_rbb = 0;
        this.set_flags(bufData, API.GameBMP.PIECES_IN_PUZZLE_RBB_0, 4, 0);
      }
      if (count_ccw !== 15) {
        count_ccw = 0;
        this.set_flags(bufData, API.GameBMP.PIECES_IN_PUZZLE_CCW_0, 4, 0);
      }
      if (count_dog !== 25) {
        count_dog = 0;
        this.set_flags(bufData, API.GameBMP.PIECES_IN_PUZZLE_DOG_0, 5, 0);
      }
      if (count_dh !== 4) {
        count_dh = 0;
        this.set_flags(bufData, API.GameBMP.PIECES_IN_PUZZLE_DH_0, 3, 0);
      }

      // Set flags back
      for (i = 11; i < 18; i++) {
        this.core.save.game_flags.set(i, bufData[i]);
      }

      this.cDB.jigsaws_completed = bufStorage;
      pData = new Net.SyncBuffered(this.ModLoader.clientLobby, 'SyncJigsaws', bufStorage, false);
      this.ModLoader.clientSide.sendPacket(pData);
    }

    this.maxPuzzleCount =
      count_mm +
      count_ttc +
      count_cc +
      count_bgs +
      count_fp +
      count_gv +
      count_mmm +
      count_rbb +
      count_ccw +
      count_dog +
      count_dh;
  }

  handle_mumbo_token_paid_count(bufData: Buffer) {
    // Initializers
    let id: number;
    let count = 0;

    // Mumbos Mountain
    id = API.GameBMP.TOKENS_PAID_MM;
    if (bufData[Math.floor(id / 8)] & (1 << (id % 8))) count += 5;

    // Mad Monster Mansion
    id = API.GameBMP.TOKENS_PAID_MMM;
    if (bufData[Math.floor(id / 8)] & (1 << (id % 8))) count += 20;

    // Freezeezy Peak
    id = API.GameBMP.TOKENS_PAID_FP;
    if (bufData[Math.floor(id / 8)] & (1 << (id % 8))) count += 15;

    // BubbleGloop Swamp
    id = API.GameBMP.TOKENS_PAID_BGS;
    if (bufData[Math.floor(id / 8)] & (1 << (id % 8))) count += 10;

    // Click Clock Woods
    id = API.GameBMP.TOKENS_PAID_CCW;
    if (bufData[Math.floor(id / 8)] & (1 << (id % 8))) count += 25;

    this.maxTokensSpent = count;
  }

  handle_game_flags(bufData: Buffer, bufStorage: Buffer) {
    // Initializers
    let pData: Net.SyncBuffered;
    let i: number;
    let count: number;
    let val: number;
    let needUpdate = false;

    bufData = this.core.save.game_flags.get_all();
    bufStorage = this.cDB.game_flags;
    count = bufData.byteLength;
    needUpdate = false;

    for (i = 0; i < count; i++) {
      if (i === 4) continue; // RBB water level
      if (i > 10 && i < 17) continue; // Puzzle gap
      if (bufData[i] === bufStorage[i]) continue;

      bufData[i] |= bufStorage[i];
      this.core.save.game_flags.set(i, bufData[i]);
      needUpdate = true;
    }

    // RBB water level
    val = bufStorage[4] & 0x0000003f;
    if ((bufData[4] & 0x0000003f) !== val) {
      bufData[4] |= val;
      this.core.save.game_flags.set(4, bufData[4]);
      needUpdate = true;
    }

    // Puzzle gap start
    val = bufStorage[11] & 0x0000001f;
    if ((bufData[11] & 0x0000001f) !== val) {
      bufData[11] |= val;
      this.core.save.game_flags.set(11, bufData[11]);
      needUpdate = true;
    }

    // Puzzle gap end
    val = bufStorage[16] & 0x000000fc;
    if ((bufData[16] & 0x000000fc) !== val) {
      bufData[16] |= val;
      this.core.save.game_flags.set(16, bufData[16]);
      needUpdate = true;
    }

    // Send Changes to Server
    if (needUpdate) {
      this.cDB.game_flags = bufData;
      pData = new Net.SyncBuffered(this.ModLoader.clientLobby, 'SyncGameFlags', bufData, false);
      this.ModLoader.clientSide.sendPacket(pData);
    }

    // Sub Flag Counters
    {
      this.handle_puzzle_count(bufData, bufStorage);
      this.handle_mumbo_token_paid_count(bufData);
    }
  }

  handle_honeycomb_flags(bufData: Buffer, bufStorage: Buffer) {
    // Initializers
    let pData: Net.SyncBuffered;
    let i: number;
    let count = 0;
    let needUpdate = false;
    bufData = this.core.save.honeycomb_flags.get_all();
    bufStorage = this.cDB.honeycomb_flags;
    count = bufData.byteLength;

    // Detect Changes
    for (i = 0; i < count; i++) {
      if (bufData[i] === bufStorage[i]) continue;
      bufData[i] |= bufStorage[i];
      this.core.save.honeycomb_flags.set(i, bufData[i]);
      needUpdate = true;
    }

    // Process Changes
    if (!needUpdate) return;

    this.cDB.honeycomb_flags = bufData;

    // Sync totals
    count = this.ModLoader.utils.utilBitCountBuffer(bufData, 0, 0);
    this.core.save.inventory.honeycombs = count % 6;
    this.core.save.inventory.health_upgrades = count / 6;
    this.core.runtime.current_health = count / 6 + 5;

    pData = new Net.SyncBuffered(this.ModLoader.clientLobby, 'SyncHoneyCombFlags', bufData, false);
    this.ModLoader.clientSide.sendPacket(pData);
  }

  handle_jiggy_flags(bufData: Buffer, bufStorage: Buffer) {
    // Initializers
    let pData: Net.SyncBuffered;
    let i: number;
    let count = 0;
    let needUpdate = false;
    bufData = this.core.save.jiggy_flags.get_all();
    bufStorage = this.cDB.jiggy_flags;
    count = bufData.byteLength;
    
    // Detect Changes
    for (i = 0; i < count; i++) {
      if (bufData[i] === bufStorage[i]) continue;
      bufData[i] |= bufStorage[i];
      this.core.save.jiggy_flags.set(i, bufData[i]);
      needUpdate = true;
    }
    
    // Sync totals
    count = this.ModLoader.utils.utilBitCountBuffer(bufData, 0, 0);
    this.core.save.inventory.jiggies = count - this.maxPuzzleCount;
    
    // Process Changes
    if (!needUpdate) return;
    
    this.cDB.jiggy_flags = bufData;
    pData = new Net.SyncBuffered(this.ModLoader.clientLobby, 'SyncJiggyFlags', bufData, false);
    this.ModLoader.clientSide.sendPacket(pData);
  }

  handle_mumbo_token_flags(bufData: Buffer, bufStorage: Buffer) {
    // Initializers
    let pData: Net.SyncBuffered;
    let i: number;
    let count = 0;
    let needUpdate = false;
    bufData = this.core.save.mumbo_token_flags.get_all();
    bufStorage = this.cDB.mumbo_token_flags;
    count = bufData.byteLength;

    // Detect Changes
    for (i = 0; i < count; i++) {
      if (bufData[i] === bufStorage[i]) continue;
      bufData[i] |= bufStorage[i];
      this.core.save.mumbo_token_flags.set(i, bufData[i]);
      needUpdate = true;
    }

    // Process Changes
    if (!needUpdate) return;

    this.cDB.mumbo_token_flags = bufData;
    pData = new Net.SyncBuffered(this.ModLoader.clientLobby, 'SyncMumboTokenFlags', bufData, false);
    this.ModLoader.clientSide.sendPacket(pData);

    // Sync totals
    count = this.ModLoader.utils.utilBitCountBuffer(bufData, 0, 0);
    this.core.save.inventory.mumbo_tokens = count - this.maxTokensSpent;
  }

  handle_note_totals(bufData: Buffer, bufStorage: Buffer) {
    // Initializers
    let pData: Net.SyncBuffered;
    let i: number;
    let count = 0;
    let needUpdate = false;
    bufData = this.core.save.note_totals.get_all();
    bufStorage = this.cDB.note_totals;
    count = bufData.byteLength;
    
    // Detect Changes
    for (i = 0; i < count; i++) {
      if (bufData[i] === bufStorage[i]) continue;
      bufData[i] = Math.max(bufData[i], bufStorage[i]);
      if (bufData[i] > 100) bufData[i] = 100;
      this.core.save.note_totals.set(i, bufData[i]);
      needUpdate = true;
    }

    // Process Changes
    if (!needUpdate) return;

    this.cDB.note_totals = bufData;
    pData = new Net.SyncBuffered(this.ModLoader.clientLobby, 'SyncNoteTotals', bufData, false);
    this.ModLoader.clientSide.sendPacket(pData);
  }

  handle_moves() {
    // Don't force sync moves on this map!
    if (this.curScene === API.SceneType.GL_FURNACE_FUN) return;
    
    // Initializers
    let pData: Net.SyncNumbered;
    let id: number;
    let val = this.core.save.moves;
    let valDB = this.cDB.moves;

    // Move Get Item Add Check
    {
      // Eggs
      id = API.MoveType.EGGS;
      if (!(val & (1 << id)) && (valDB & (1 << id))) {
        this.core.save.inventory.eggs += 50;
      }

      // Red Feathers
      id = API.MoveType.FLYING;
      if (!(val & (1 << id)) && (valDB & (1 << id))) {
        this.core.save.inventory.red_feathers += 25;
      }

      // Gold Feathers
      id = API.MoveType.WONDERWING;
      if (!(val & (1 << id)) && (valDB & (1 << id))) {
        this.core.save.inventory.gold_feathers += 5;
      }
    }

    // Detect Changes
    if (val === valDB) return;
    
    // Process Changes
    val |= valDB;
    this.core.save.moves = val;

    // Send Changes to Server
    this.cDB.moves = val;
    pData = new Net.SyncNumbered(this.ModLoader.clientLobby, 'SyncMoves', val, false);
    this.ModLoader.clientSide.sendPacket(pData);

    // Perform heal
    let honeycombs = this.core.save.honeycomb_flags.get_all();
    let count = this.ModLoader.utils.utilBitCountBuffer(honeycombs, 0, 0);
    this.core.runtime.current_health = count / 6 + 5;
  }

  handle_events_level() {
    // Initializers
    let pData: Net.SyncNumbered;
    let evt = this.core.runtime.current_level_events;
    let crc1: number;
    let crc2: number;
    let i: number;
    let tmp: number;

    // Detect Changes
    if (evt === this.cDB.level_events) return;

    // Process Changes
    evt |= this.cDB.level_events;

    // Dont update while these cutscenes are active!
    if (
      (evt & (1 << API.EventLevelBMP.CUTSCENE_TTC_OPENING)) ||
      (evt & (1 << API.EventLevelBMP.CUTSCENE_BGS_OPENING)) ||
      (evt & (1 << API.EventLevelBMP.CUTSCENE_RBB_ENGINE_ROOM_RIGHT)) ||
      (evt & (1 << API.EventLevelBMP.CUTSCENE_RBB_ENGINE_ROOM_RIGHT)) ||
      (evt & (1 << API.EventLevelBMP.CUTSCENE_TTC_SANDCASTLE_WATER_LOWERED)) ||
      (evt & (1 << API.EventLevelBMP.CUTSCENE_GV_MOTE_FILLED_CUTSCENE))
    ) return;
    
    this.cDB.level_events = evt;
    this.core.runtime.current_level_events = evt;

    //correct CRCs in game
    // TODO: move addresses into modloader API -- mittenz
    crc1 = 0x5c9ec23;
    crc2 = 0x3f2f59a;
    for (i = 0; i < 7; i++) {
        tmp = this.ModLoader.emulator.rdramRead8(0x80383328 + i);//CUR_SCENE_EVENTS
        crc2 += (i+7)*tmp;
        crc1 = (tmp*0x0d) ^ (((crc1 + tmp) & 0x7f) << 0x14) ^ (crc1 >> 7); 
    }
    this.ModLoader.emulator.rdramWrite32(0x80383320, crc1);
    this.ModLoader.emulator.rdramWrite32(0x80383324, crc2);

    pData = new Net.SyncNumbered(this.ModLoader.clientLobby, 'SyncLevelEvents', evt, false);
    this.ModLoader.clientSide.sendPacket(pData);
  }

  handle_events_scene() {
    // Initializers
    let level = this.curLevel;
    let scene = this.curScene;
    let needUpdate = false;
    
    // Ensure we have this level/scene data!
    this.check_db_instance(this.cDB, level, scene);   
    
    let evt = this.cDB.level_data[level].scene[scene].events; 

    switch (this.curScene) {
      case API.SceneType.SM_MAIN:
        // First Bottles Interaction
        if (this.core.save.moves !== 0) {
          evt |= 1 << API.EventSceneBMP.SM_BOTTLES_FIRST_TALK;
        }

        // Bridge Bottles Interaction
        if (this.core.save.moves >= 40377) {
          evt |= 1 << API.EventSceneBMP.SM_BOTTLES_TUTORIAL_FINISH;
          evt |= 1 << API.EventSceneBMP.SM_AQUIRED_ALL_SM_ATTACKS;
        }

        // Bridge Dialogue Already Complete
        if (this.cDB.level_data.hasOwnProperty(API.LevelType.GRUNTILDAS_LAIR)) {
          evt |= 1 << API.EventSceneBMP.SM_FIST_TOP_BOTTLES_TALK;
          evt |= 1 << API.EventSceneBMP.SM_END_TUTORIAL;
        }
    }

    // Only safe data will get through
    if ((this.core.runtime.current_scene_events & evt) === evt &&
        !needUpdate) return;

    // Set correct data in game and to database
    this.core.runtime.current_scene_events |= evt;
    this.cDB.level_data[level].scene[scene].events = evt;

    //correct CRCs in game
    // TODO: move addresses into modloader API -- mittenz
    this.ModLoader.emulator.rdramWrite32(0x8037dde0, evt^0x1195e97);
    this.ModLoader.emulator.rdramWrite32(0x8037dde4, evt^0xa84e38c8);
    this.ModLoader.emulator.rdramWrite32(0x8037dde8, evt^0x3973e4d9);

    // Send changes to network
    let pData = new Net.SyncSceneNumbered(
      this.ModLoader.clientLobby,
      'SyncSceneEvents',
      level,
      scene, 
      this.core.runtime.current_scene_events,
      false
    );
    this.ModLoader.clientSide.sendPacket(pData);
  }

  handle_items() {

  }

  handle_collision(scene: API.SceneType) {
    // Initializers
    let pData: Net.SyncLevelNumbered;
    let level = this.curLevel;
    let addr = 0;
    let ptr = 0;
    let i = 0;
    let foundJinjo = false;

    // Actors (By Model ID)
    for (i = 0; i < 5; i++) {
      addr = this.ocollision_addr + (i * 4);

      switch (this.ModLoader.emulator.rdramRead32(addr)) {
        case 0x06d6: // Notes
          this.oNoteCount += 1;
          if (this.cDB.level_data[level].onotes < this.oNoteCount) {
            this.cDB.level_data[level].onotes = this.oNoteCount;
            pData = new Net.SyncLevelNumbered(
              this.ModLoader.clientLobby,
              'SyncObjectNotes',
              level,
              this.cDB.level_data[level].onotes,
              false
            );
            this.ModLoader.clientSide.sendPacket(pData);
          }
          break;
        
        case 0x03C0: // Blue Jinjo
          this.cDB.level_data[level].jinjos |= 1 << 0;
          foundJinjo = true;
          break;

        case 0x03C2: // Green Jinjo
          this.cDB.level_data[level].jinjos |= 1 << 1;
          foundJinjo = true;
          break;

        case 0x03BC: // Orange Jinjo
          this.cDB.level_data[level].jinjos |= 1 << 2;
          foundJinjo = true;
          break;

        case 0x03C1: // Pink Jinjo
          this.cDB.level_data[level].jinjos |= 1 << 3;
          foundJinjo = true;
          break;

        case 0x03BB: // Yellow Jinjo
          this.cDB.level_data[level].jinjos |= 1 << 4;
          foundJinjo = true;
          break;
      }
      
      this.ModLoader.emulator.rdramWrite32(addr, 0);
    }

    // Voxels (By Struct)
    for (i = 0; i < 5; i++) {
      addr = this.vcollision_addr + (i * 4);

      ptr = this.ModLoader.emulator.dereferencePointer(addr);
      if (ptr !== 0) {
        let name = '';

        switch (this.ModLoader.emulator.rdramRead16(ptr)) {
          case 0x1640: // Notes
            name += this.ModLoader.emulator.rdramRead16(ptr + 0x04) +
                    this.ModLoader.emulator.rdramRead16(ptr + 0x06) +
                    this.ModLoader.emulator.rdramRead16(ptr + 0x08);
            if (!this.cDB.level_data[level].scene[scene].notes.includes(name)) {
              this.cDB.level_data[level].scene[scene].notes.push(name);
              let pData = new Net.SyncVoxelNotes(
                this.ModLoader.clientLobby,
                level,
                scene,
                this.cDB.level_data[level].scene[scene].notes,
                false
              );
              this.ModLoader.clientSide.sendPacket(pData);
            } 
            break;
        }
      }

      this.ModLoader.emulator.rdramWrite32(addr, 0);
    }

    // Handle jinjo from voxel OR model.
    if (foundJinjo) {
      pData = new Net.SyncLevelNumbered(
        this.ModLoader.clientLobby,
        'SyncJinjos', 
        level, 
        this.cDB.level_data[level].jinjos, 
        false
      );
      this.ModLoader.clientSide.sendPacket(pData);
    }
  }

  handle_permanence_counts() {
    // Initializers
    let level = this.curLevel;
    let count: number;

    // Handle Level Jinjos
    {
      this.core.runtime.current_level.jinjos =
        this.cDB.level_data[level].jinjos
    }

    // Handle Scene Notes
    {
      // Totals override!
      if (this.cDB.note_totals[level] === 0x64) {
        this.core.runtime.current_level.notes = 0x64;
      } else {
        // Object Count
        count = this.cDB.level_data[level].onotes;
        
        // Voxel Count
        Object.keys(this.cDB.level_data[level].scene).forEach((key: string) => {
          count += this.cDB.level_data[level].scene[key].notes.length;
        });

        // Detect Changes
        if (this.core.runtime.current_level.notes !== count) {
          this.needDeleteVoxels = true;
        }

        // Correct Total
        this.core.runtime.current_level.notes = count;
      }
    }
  }

  delete_actor(ptr: number) {
    let n = this.ModLoader.emulator.rdramRead8(ptr + 0x47) | 0x08;
    this.ModLoader.emulator.rdramWrite8(ptr + 0x47, n);
  }

  handle_despawn_actors() {
    // Make sure we should activate this!
    if (!this.needDeleteActors) return;

    // Reset now in case net updates durring loop
    this.needDeleteActors = false;

    // Initializers
    let ptr = this.ModLoader.emulator.dereferencePointer(this.actor_arr_addr);
    let count = this.ModLoader.emulator.rdramRead32(ptr);
    let level = this.curLevel;
    let subPtr: number;
    let id: number;
    let i: number;
    let val: number;
    let bit: number;

    // Get into first actor
    ptr += 0x08;

    // Loop all actors
    for (i = 0; i < count; i++) {
      subPtr = this.ModLoader.emulator.dereferencePointer(ptr + 0x012c);
      id = this.ModLoader.emulator.rdramRead16(subPtr + 2);

      switch (id) {
        case API.ActorType.EMPTY_HONEYCOMB_PIECE:
          id = this.ModLoader.emulator.rdramRead32(ptr + 0x7c);
          val = Math.floor(id / 8);
          bit = id % 8;
          if (bit === 0) val -= 1;
          val = this.cDB.honeycomb_flags[val];
          if ((val & (1 << (bit))) !== 0)
            this.delete_actor(ptr);
          break;

        case API.ActorType.JIGGY:
          id = this.ModLoader.emulator.rdramRead32(ptr + 0x80);
          val = Math.floor(id / 8);
          bit = id % 8;
          if (bit === 0) val -= 1;
          val = this.cDB.jiggy_flags[val];
          if ((val & (1 << (bit))) !== 0)
            this.delete_actor(ptr);
          break;

        case API.ActorType.MUMBO_TOKEN:
          id = this.ModLoader.emulator.rdramRead32(ptr + 0x7c);
          val = Math.floor(id / 8);
          bit = id % 8;
          if (bit === 0) val -= 1;
          val = this.cDB.mumbo_token_flags[val];
          if ((val & (1 << (bit))) !== 0)
            this.delete_actor(ptr);
          break;

        // Jinjos (By Color)
        case API.ActorType.COLLECTABLE_JINJO_BLUE:
          val = API.JinjoType.BLUE;
          if ((this.cDB.level_data[level].jinjos & (1 << val)) !== 0) {
            this.delete_actor(ptr);
          }
          break;

        case API.ActorType.COLLECTABLE_JINJO_GREEN:
          val = API.JinjoType.GREEN;
          if ((this.cDB.level_data[level].jinjos & (1 << val)) !== 0) {
            this.delete_actor(ptr);
          }
          break;
          
        case API.ActorType.COLLECTABLE_JINJO_ORANGE:
          val = API.JinjoType.ORANGE;
          if ((this.cDB.level_data[level].jinjos & (1 << val)) !== 0) {
            this.delete_actor(ptr);
          }
          break;
          
        case API.ActorType.COLLECTABLE_JINJO_PINK:
          val = API.JinjoType.PINK;
          if ((this.cDB.level_data[level].jinjos & (1 << val)) !== 0) {
            this.delete_actor(ptr);
          }
          break;
          
        case API.ActorType.COLLECTABLE_JINJO_YELLOW:
          val = API.JinjoType.YELLOW;
          if ((this.cDB.level_data[level].jinjos & (1 << val)) !== 0) {
            this.delete_actor(ptr);
          }
          break;

        default:
      }
      
      // Advance to next struct
      ptr += 0x0180;
    }
  }

  mod_voxel(ptr: number, spawn: boolean) {  
    if (spawn) {
      this.ModLoader.emulator.rdramWrite8(ptr + 0x0B, 0x10);
    } else {
      this.ModLoader.emulator.rdramWrite8(ptr + 0x0B, 0x00);
    }
  }

  despawn_voxel_item(ptr: number) {
    let level = this.curLevel;
    let scene = this.curScene;
    let name = '';

    switch (this.ModLoader.emulator.rdramRead16(ptr)) {      
      case 0x1640: // Notes
        // Total overrides
        if (this.cDB.note_totals[level] === 0x64) {
          this.mod_voxel(ptr, false);
        } else {
          name += this.ModLoader.emulator.rdramRead16(ptr + 0x04) +
                  this.ModLoader.emulator.rdramRead16(ptr + 0x06) +
                  this.ModLoader.emulator.rdramRead16(ptr + 0x08);
          // We have this item, despawn it
          if (this.cDB.level_data[level].scene[scene].notes.includes(name)) {
            this.mod_voxel(ptr, false);
          } else { // We don't have this, make it visible again!
            this.mod_voxel(ptr, true);
          }
        }
        break;      
    }
  }

  despawn_voxel_list(ptr: number) {
    let count = (this.ModLoader.emulator.rdramRead32(ptr) >> 5) & 0x0000003F;
    if (count === 0) return;

    let subPtr = this.ModLoader.emulator.dereferencePointer(ptr + 0x08);
    let i: number;

    for (i = 0; i < count; i++) {
      if (subPtr !== 0) this.despawn_voxel_item(subPtr);

      // Advance to next list
      subPtr += 0x0C;
    }
  }

  despawn_voxel_struct() {
    // Initializers
    let ptr = this.ModLoader.emulator.dereferencePointer(this.voxel_arr_addr);
    let count = this.ModLoader.emulator.rdramRead32(this.voxel_cnt_addr);
    let i: number;

    for (i = 0; i < count; i++) {
      this.despawn_voxel_list(ptr);

      // Advance to next struct
      ptr += 0x0C;
    }
  }

  handle_despawn_voxels() {
    // Make sure we should activate this!
    if (!this.needDeleteVoxels) return;

    // Reset now in case net updates durring loop
    this.needDeleteVoxels = false;
    
    // Make sure we have content to delete!
    let level = this.curLevel;
    let scene = this.curScene;
    if (this.cDB.level_data[level].scene[scene].notes.Length < 1) return;
    
    // Call actual despawn algorithm
    this.despawn_voxel_struct();
  }

  constructor() {}

  preinit(): void {
    this.pMgr = new Puppet.PuppetManager();
  }

  init(): void {
    global.ModLoader['BK:puppet_address'] = 0x401000;
    this.actor_arr_addr = global.ModLoader[API.AddressType.RT_ACTOR_ARRAY_PTR];
    this.beta_menu_addr = global.ModLoader[API.AddressType.BETA_MENU];
    this.collision_addr = global.ModLoader[API.AddressType.RT_COLLISION_PTR];
    this.level_lookup_addr = global.ModLoader[API.AddressType.RT_CUR_LEVEL_LOOKUP];
    this.ocollision_addr = 0x401180;
    this.vcollision_addr = 0x401100;
    this.voxel_arr_addr = global.ModLoader[API.AddressType.RT_VOXEL_ARRAY_PTR];    
    this.voxel_cnt_addr = global.ModLoader[API.AddressType.RT_VOXEL_COUNT_PTR];    
  }

  postinit(): void {
    // Puppet Manager Inject
    this.pMgr.postinit(
      this.ModLoader.emulator,
      this.core,
      this.ModLoader.me,
      this.ModLoader
    );

    this.ModLoader.logger.info('Puppet manager activated.');
  }

  onTick(): void {
    if (!this.core.isPlaying() || this.core.runtime.is_cutscene()) {
      // Cutscene skip (Needs addresses embedded to core)
      this.ModLoader.emulator.rdramWrite8(0x80383D20, 0x11);
      this.ModLoader.emulator.rdramWrite8(0x80383D98, 0x11);
      this.ModLoader.emulator.rdramWrite8(0x80383E10, 0x11);
      this.ModLoader.emulator.rdramWrite8(0x80383E88, 0x11);         

      return;
    }

    // Initializers
    let transitState = this.core.runtime.get_transition_state();
    let scene: API.SceneType = this.core.runtime.current_scene;
    let inTransit: boolean = !(transitState === 0 || transitState === 4);
    let isLoading: boolean = this.core.runtime.is_loading();
    let bufStorage: Buffer;
    let bufData: Buffer;
    
    // Activate Gruntilda Lair Menu Option
    if (this.curLevel !== API.LevelType.GRUNTILDAS_LAIR &&
        this.curLevel !== API.LevelType.SPIRAL_MOUNTAIN
    ) this.ModLoader.emulator.rdramWrite8(this.beta_menu_addr, 1);

    // General Setup/Handlers
    this.handle_scene_change(scene);
    this.read_events();
    this.handle_puppets(scene, isLoading, inTransit);

    // Progress Flags Handlers
    this.handle_game_flags(bufData!, bufStorage!);
    this.handle_honeycomb_flags(bufData!, bufStorage!);
    this.handle_jiggy_flags(bufData!, bufStorage!);
    this.handle_mumbo_token_flags(bufData!, bufStorage!);

    // Non-Flags Handlers
    this.handle_moves();
    this.handle_events_level();
    this.handle_events_scene();
    this.handle_items();

    // Order-Specific Handlers
    this.handle_collision(scene);
    this.handle_permanence_counts();
    this.handle_note_totals(bufData!, bufStorage!);

    // Force Despawn Code
    if (transitState !== 0) return;
    this.handle_despawn_actors();
    this.handle_despawn_voxels();
  }

  @EventHandler(EventsClient.ON_INJECT_FINISHED)
  onClient_InjectFinished(evt: any) {
    if (!this.isRelease) this.core.runtime.goto_scene(0x91, 0x00);
  }

  @EventHandler(EventsServer.ON_LOBBY_CREATE)
  onServer_LobbyCreate(lobby: string) {
    this.ModLoader.lobbyManager.createLobbyStorage(
      lobby, 
      this, 
      new Net.DatabaseServer()
    );
  }

  @EventHandler(EventsClient.ON_LOBBY_JOIN)
  onClient_LobbyJoin(lobby: LobbyData): void {
    this.cDB = new Net.DatabaseClient();
    let pData = new Packet('Request_Storage', 'BkOnline', this.ModLoader.clientLobby, false);
    this.ModLoader.clientSide.sendPacket(pData);
  }

  @EventHandler(EventsServer.ON_LOBBY_JOIN)
  onServer_LobbyJoin(evt: EventServerJoined) {
    let storage: Net.DatabaseServer = this.ModLoader.lobbyManager.getLobbyStorage(evt.lobby, this) as Net.DatabaseServer;
    storage.players[evt.player.uuid] = -1;
    storage.playerInstances[evt.player.uuid] = evt.player;
  }

  @EventHandler(EventsServer.ON_LOBBY_LEAVE)
  onServer_LobbyLeave(evt: EventServerLeft) {
    let storage: Net.DatabaseServer = this.ModLoader.lobbyManager.getLobbyStorage(evt.lobby, this) as Net.DatabaseServer;
    delete storage.players[evt.player.uuid];
    delete storage.playerInstances[evt.player.uuid];
  }

  @EventHandler(EventsClient.ON_SERVER_CONNECTION)
  onClient_ServerConnection(evt: any) {
    this.pMgr.reset();
    if (this.core.runtime === undefined || !this.core.isPlaying) return;
    let pData = new Net.SyncLocation(this.ModLoader.clientLobby, this.curLevel, this.curScene)
    this.ModLoader.clientSide.sendPacket(pData);
  }

  @EventHandler(EventsClient.ON_PLAYER_JOIN)
  onClient_PlayerJoin(nplayer: INetworkPlayer) {
    this.pMgr.registerPuppet(nplayer);
  }

  @EventHandler(EventsClient.ON_PLAYER_LEAVE)
  onClient_PlayerLeave(nplayer: INetworkPlayer) {
    this.pMgr.unregisterPuppet(nplayer);
  }

  // #################################################
  // ##  Server Receive Packets
  // #################################################

  @ServerNetworkHandler('Request_Storage')
  onServer_RequestStorage(packet: Packet): void {
    this.ModLoader.logger.info('[Server] Sending: {Lobby Storage}');
    let sDB: Net.DatabaseServer = this.ModLoader.lobbyManager.getLobbyStorage(packet.lobby, this) as Net.DatabaseServer;
    let pData = new Net.SyncStorage(
      packet.lobby,
      sDB.game_flags,
      sDB.honeycomb_flags,
      sDB.jiggy_flags,
      sDB.mumbo_token_flags,
      sDB.note_totals,
      sDB.jigsaws_completed,
      sDB.level_data,
      sDB.level_events,
      sDB.moves
    );
    this.ModLoader.serverSide.sendPacketToSpecificPlayer(pData, packet.player);
  }

  @ServerNetworkHandler('SyncGameFlags')
  onServer_SyncGameFlags(packet: Net.SyncBuffered) {
    this.ModLoader.logger.info('[Server] Received: {Game Flags}');

    let sDB: Net.DatabaseServer = this.ModLoader.lobbyManager.getLobbyStorage(packet.lobby, this) as Net.DatabaseServer;
    let data: Buffer = sDB.game_flags;
    let count: number = data.byteLength;
    let i = 0;
    let needUpdate = false;

    for (i = 0; i < count; i++) {
      if (data[i] === packet.value[i]) continue;
      data[i] |= packet.value[i];
      needUpdate = true;
    }

    if (!needUpdate) return;

    sDB.game_flags = data;

    let pData = new Net.SyncBuffered(packet.lobby, 'SyncGameFlags', data, true);
    this.ModLoader.serverSide.sendPacket(pData);

    this.ModLoader.logger.info('[Server] Updated: {Game Flags}');
  }

  @ServerNetworkHandler('SyncHoneyCombFlags')
  onServer_SyncHoneyCombFlags(packet: Net.SyncBuffered) {
    this.ModLoader.logger.info('[Server] Received: {HoneyComb Flags}');

    let sDB: Net.DatabaseServer = this.ModLoader.lobbyManager.getLobbyStorage(packet.lobby, this) as Net.DatabaseServer;
    let data: Buffer = sDB.honeycomb_flags;
    let count: number = data.byteLength;
    let i = 0;
    let needUpdate = false;

    for (i = 0; i < count; i++) {
      if (data[i] === packet.value[i]) continue;
      data[i] |= packet.value[i];
      needUpdate = true;
    }

    if (!needUpdate) return;
      
    sDB.honeycomb_flags = data;
      
    let pData = new Net.SyncBuffered(packet.lobby, 'SyncHoneyCombFlags', data, true);
    this.ModLoader.serverSide.sendPacket(pData);

    this.ModLoader.logger.info('[Server] Updated: {HoneyComb Flags}');
  }

  @ServerNetworkHandler('SyncJiggyFlags')
  onServer_SyncJiggyFlags(packet: Net.SyncBuffered) {
    this.ModLoader.logger.info('[Server] Received: {Jiggy Flags}');

    let sDB: Net.DatabaseServer = this.ModLoader.lobbyManager.getLobbyStorage(packet.lobby, this) as Net.DatabaseServer;
    let data: Buffer = sDB.jiggy_flags;
    let count: number = data.byteLength;
    let i = 0;
    let needUpdate = false;

    for (i = 0; i < count; i++) {
      if (data[i] === packet.value[i]) continue;
      data[i] |= packet.value[i];
      needUpdate = true;
    }

    if (!needUpdate) return;
      
    sDB.jiggy_flags = data;
      
    let pData = new Net.SyncBuffered(packet.lobby, 'SyncJiggyFlags', data, true);
    this.ModLoader.serverSide.sendPacket(pData);

    this.ModLoader.logger.info('[Server] Updated: {Jiggy Flags}');
  }

  @ServerNetworkHandler('SyncMoves')
  onServer_SyncMoves(packet: Net.SyncNumbered) {
    this.ModLoader.logger.info('[Server] Received: {Move Flags}');

    let sDB: Net.DatabaseServer = this.ModLoader.lobbyManager.getLobbyStorage(packet.lobby, this) as Net.DatabaseServer;
    if (sDB.moves === packet.value) return;    
    sDB.moves |= packet.value;

    let pData = new Net.SyncNumbered(packet.lobby, 'SyncMoves', sDB.moves, true);
    this.ModLoader.serverSide.sendPacket(pData);

    this.ModLoader.logger.info('[Server] Updated: {Move Flags}');    
  }

  @ServerNetworkHandler('SyncMumboTokenFlags')
  onServer_SyncMumboTokenFlags(packet: Net.SyncBuffered) {
    this.ModLoader.logger.info('[Server] Received: {Mumbo Token Flags}');

    let sDB: Net.DatabaseServer = this.ModLoader.lobbyManager.getLobbyStorage(packet.lobby, this) as Net.DatabaseServer;
    let data: Buffer = sDB.mumbo_token_flags;
    let count: number = data.byteLength;
    let i = 0;
    let needUpdate = false;

    for (i = 0; i < count; i++) {
      if (data[i] === packet.value[i]) continue;
      data[i] |= packet.value[i];
      needUpdate = true;
    }

    if (!needUpdate) return;
      
    sDB.mumbo_token_flags = data;

    let pData = new Net.SyncBuffered(packet.lobby, 'SyncMumboTokenFlags', data, true);
    this.ModLoader.serverSide.sendPacket(pData);

    this.ModLoader.logger.info('[Server] Updated: {Mumbo Token Flags}');
  }

  @ServerNetworkHandler('SyncNoteTotals')
  onServer_SyncSyncNoteTotals(packet: Net.SyncBuffered) {
    this.ModLoader.logger.info('[Server] Received: {Note Totals}');

    let sDB: Net.DatabaseServer = this.ModLoader.lobbyManager.getLobbyStorage(packet.lobby, this) as Net.DatabaseServer;
    let data: Buffer = sDB.note_totals;
    let count: number = data.byteLength;
    let i = 0;
    let needUpdate = false;

    for (i = 0; i < count; i++) {
      if (data[i] === packet.value[i]) continue;
      data[i] = Math.max(data[i], packet.value[i]);
      if (data[i] > 100) data[i] = 100;
      needUpdate = true;
    }

    if (!needUpdate) return;
    
    sDB.note_totals = data;

    let pData = new Net.SyncBuffered(packet.lobby, 'SyncNoteTotals', data, true);
    this.ModLoader.serverSide.sendPacket(pData);

    this.ModLoader.logger.info('[Server] Updated: {Note Totals}');
  }

  @ServerNetworkHandler('SyncJigsaws')
  onServer_SyncJigsaws(packet: Net.SyncBuffered) {
    this.ModLoader.logger.info('[Server] Received: {Jigsaws Completion}');

    let sDB: Net.DatabaseServer = this.ModLoader.lobbyManager.getLobbyStorage(packet.lobby, this) as Net.DatabaseServer;
    let data: Buffer = sDB.jigsaws_completed;
    let count: number = data.byteLength;
    let i = 0;
    let needUpdate = false;

    for (i = 0; i < count; i++) {
      if (data[i] >= packet.value[i]) continue;
      if (packet.value[i] > 0) data[i] = 1;
      needUpdate = true;
    }

    if (!needUpdate) return;
    
    sDB.jigsaws_completed = data;

    let pData = new Net.SyncBuffered(packet.lobby, 'SyncJigsaws', data, true);
    this.ModLoader.serverSide.sendPacket(pData);

    this.ModLoader.logger.info('[Server] Updated: {Jigsaws Completion}');
  }

  @ServerNetworkHandler('SyncLevelEvents')
  onServer_SyncLevelEvents(packet: Net.SyncNumbered) {
    this.ModLoader.logger.info('[Server] Received: {Level Events}');

    let sDB: Net.DatabaseServer = this.ModLoader.lobbyManager.getLobbyStorage(packet.lobby, this) as Net.DatabaseServer;
    if (sDB.level_events === packet.value) return;    
    sDB.level_events |= packet.value;

    let pData = new Net.SyncNumbered(packet.lobby,'SyncLevelEvents', sDB.level_events, true);
    this.ModLoader.serverSide.sendPacket(pData);

    this.ModLoader.logger.info('[Server] Updated: {Level Events}');
  }

  // Puppet Tracking

  @ServerNetworkHandler('SyncLocation')
  onServer_SyncLocation(packet: Net.SyncLocation) {
    
    let sDB: Net.DatabaseServer = this.ModLoader.lobbyManager.getLobbyStorage(packet.lobby, this) as Net.DatabaseServer;
    let pMsg = 'Player[' + packet.player.nickname + ']';
    let lMsg = 'Level[' + API.LevelType[packet.level] + ']';
    let sMsg = 'Scene[' + API.SceneType[packet.scene] + ']';
    sDB.players[packet.player.uuid] = packet.scene;
    this.ModLoader.logger.info('[Server] Received: {Player Scene}');
    this.ModLoader.logger.info('[Server] Updated: ' + pMsg + ' to ' + sMsg + ' of ' + lMsg);

    if (packet.level === API.LevelType.UNKNOWN ||
        packet.scene === API.SceneType.UNKNOWN) return;
    
    this.check_db_instance(sDB, packet.level, packet.scene);
  }

  @ServerNetworkHandler('SyncPuppet')
  onServer_SyncPuppet(packet: Net.SyncPuppet) {
    let sDB: Net.DatabaseServer = this.ModLoader.lobbyManager.getLobbyStorage(packet.lobby, this) as Net.DatabaseServer;
    Object.keys(sDB.players).forEach((key: string) => {
      if (sDB.players[key] !== sDB.players[packet.player.uuid]) {
        return;
      }

      if (!sDB.playerInstances.hasOwnProperty(key)) return;
      if (sDB.playerInstances[key].uuid === packet.player.uuid) {
        return;
      }

      this.ModLoader.serverSide.sendPacketToSpecificPlayer(
        packet,
        sDB.playerInstances[key]
      );
    });
  }

  // Level Tracking

  @ServerNetworkHandler('SyncJinjos')
  onServer_SyncJinjos(packet: Net.SyncLevelNumbered) {
    this.ModLoader.logger.info('[Server] Received: {Jinjo}');

    let sDB: Net.DatabaseServer = this.ModLoader.lobbyManager.getLobbyStorage(packet.lobby, this) as Net.DatabaseServer;
    let level = packet.level;
    
    // Ensure we have this level/scene data!
    this.check_db_instance(sDB, level, 0);    

    let map = sDB.level_data[level];
    if (map.jinjos === packet.value) return;
    map.jinjos |= packet.value;

    // Check Jinjo Count
    if (sDB.level_data[level].jinjos === 0x1f) {
      // Set level specific jiggy flag
      let offset = 0;

      switch (packet.level) {
        case API.LevelType.MUMBOS_MOUNTAIN:
          offset = 0x01;
          break;
        case API.LevelType.TREASURE_TROVE_COVE:
          offset = 0x0b;
          break;
        case API.LevelType.CLANKERS_CAVERN:
          offset = 0x15;
          break;
        case API.LevelType.BUBBLE_GLOOP_SWAMP:
          offset = 0x1f;
          break;
        case API.LevelType.FREEZEEZY_PEAK:
          offset = 0x29;
          break;
        case API.LevelType.GOBEYS_VALEY:
          offset = 0x3d;
          break;
        case API.LevelType.CLICK_CLOCK_WOODS:
          offset = 0x47;
          break;
        case API.LevelType.RUSTY_BUCKET_BAY:
          offset = 0x51;
          break;
        case API.LevelType.MAD_MONSTER_MANSION:
          offset = 0x5b;
          break;
      }

      sDB.jiggy_flags[Math.floor(offset / 8)] |= 1 << (offset % 8);
      let pData = new Net.SyncBuffered(packet.lobby, 'SyncJiggyFlags', sDB.jiggy_flags, true);
      this.ModLoader.serverSide.sendPacket(pData);
    }

    let pData = new Net.SyncLevelNumbered(
      packet.lobby,
      'SyncJinjos',
      level,
      map.jinjos,
      true
    );
    this.ModLoader.serverSide.sendPacket(pData);

    this.ModLoader.logger.info('[Server] Updated: {Jinjo}');
  }

  @ServerNetworkHandler('SyncObjectNotes')
  onServer_SyncObjectNotes(packet: Net.SyncLevelNumbered) {
    this.ModLoader.logger.info('[Server] Received: {Level Note Count}');

    let sDB: Net.DatabaseServer = this.ModLoader.lobbyManager.getLobbyStorage(packet.lobby, this) as Net.DatabaseServer;
    let level = packet.level;
    
    // Ensure we have this level/scene data!
    this.check_db_instance(sDB, level, 0);    

    let map = sDB.level_data[level];
    if (map.onotes >= packet.value) return;
    map.onotes = packet.value;

    let pData = new Net.SyncLevelNumbered(packet.lobby, 'SyncObjectNotes', level, map.onotes, true);
    this.ModLoader.serverSide.sendPacket(pData);

    this.ModLoader.logger.info('[Server] Updated: {Level Note Count}');
  }

  @ServerNetworkHandler('SyncVoxelNotes')
  onServer_SyncVoxelNotes(packet: Net.SyncVoxelNotes) {
    this.ModLoader.logger.info('[Server] Received: {Level Note Count}');

    let sDB: Net.DatabaseServer = this.ModLoader.lobbyManager.getLobbyStorage(packet.lobby, this) as Net.DatabaseServer;
    let level = packet.level;
    let scene = packet.scene;
    
    // Ensure we have this level/scene data!
    this.check_db_instance(sDB, level, scene);    

    let map = sDB.level_data[level].scene[scene];
    let i = 0;
    let needsUpdate = false;

    for (i = 0; i < packet.notes.length; i++) {
      if (!map.notes.includes(packet.notes[i])) {
        map.notes.push(packet.notes[i]);
        needsUpdate = true;
      }
    }

    if (!needsUpdate) return;

    let pData = new Net.SyncVoxelNotes(packet.lobby, level, scene, map.notes, true);
    this.ModLoader.serverSide.sendPacket(pData);

    this.ModLoader.logger.info('[Server] Updated: {Level Note Count}');
  }

  // #################################################
  // ##  Client Receive Packets
  // #################################################

  @NetworkHandler('SyncStorage')
  onClient_SyncStorage(packet: Net.SyncStorage): void {
    this.ModLoader.logger.info('[Client] Received: {Lobby Storage}');
    this.cDB.game_flags = packet.game_flags;
    this.cDB.honeycomb_flags = packet.honeycomb_flags;
    this.cDB.jiggy_flags = packet.jiggy_flags;
    this.cDB.mumbo_token_flags = packet.mumbo_token_flags;
    this.cDB.note_totals = packet.note_totals;
    this.cDB.jigsaws_completed = packet.jigsaws_completed;
    this.cDB.level_data = packet.level_data;
    this.cDB.level_events = packet.level_events;
    this.cDB.moves = packet.moves;
  }

  @NetworkHandler('SyncGameFlags')
  onClient_SyncGameFlags(packet: Net.SyncBuffered) {
    this.ModLoader.logger.info('[Client] Received: {Game Flags}');

    let data: Buffer = this.cDB.game_flags;
    let count: number = data.byteLength;
    let i = 0;
    let needUpdate = false;

    for (i = 0; i < count; i++) {
      if (data[i] === packet.value[i]) continue;
      data[i] |= packet.value[i];
      needUpdate = true;
    }

    if (!needUpdate) return;
    
    this.cDB.game_flags = data;
    
    this.ModLoader.logger.info('[Client] Updated: {Game Flags}');
  }

  @NetworkHandler('SyncHoneyCombFlags')
  onClient_SyncHoneyCombFlags(packet: Net.SyncBuffered) {
    this.ModLoader.logger.info('[Client] Received: {HoneyComb Flags}');

    let data: Buffer = this.cDB.honeycomb_flags;
    let count: number = data.byteLength;
    let i = 0;
    let needUpdate = false;

    for (i = 0; i < count; i++) {
      if (data[i] === packet.value[i]) continue;
      data[i] |= packet.value[i];
      needUpdate = true;
    }

    if (!needUpdate) return;

    this.cDB.honeycomb_flags = data;
    this.needDeleteActors = true;
    
    this.ModLoader.logger.info('[Client] Updated: {HoneyComb Flags}');
  }

  @NetworkHandler('SyncJiggyFlags')
  onClient_SyncJiggyFlags(packet: Net.SyncBuffered) {
    this.ModLoader.logger.info('[Client] Received: {Jiggy Flags}');
    let data: Buffer = this.cDB.jiggy_flags;
    let count: number = data.byteLength;
    let i = 0;
    let needUpdate = false;

    for (i = 0; i < count; i++) {
      if (data[i] === packet.value[i]) continue;
      data[i] |= packet.value[i];
      needUpdate = true;
    }
    if (!needUpdate) return;

    this.cDB.jiggy_flags = data;
    this.needDeleteActors = true;
    
    this.ModLoader.logger.info('[Client] Updated: {Jiggy Flags}');
  }

  @NetworkHandler('SyncMoves')
  onClient_SyncMoves(packet: Net.SyncNumbered) {
    this.ModLoader.logger.info('[Client] Received: {Move Flags}');

    if (this.cDB.moves === packet.value) return;    
    this.cDB.moves |= packet.value;

    this.ModLoader.logger.info('[Client] Updated: {Move Flags}');
  }

  @NetworkHandler('SyncMumboTokenFlags')
  onClient_SyncMumboTokenFlags(packet: Net.SyncBuffered) {
    this.ModLoader.logger.info('[Client] Received: {Mumbo Token Flags}');

    let data: Buffer = this.cDB.mumbo_token_flags;
    let count: number = data.byteLength;
    let i = 0;
    let needUpdate = false;

    for (i = 0; i < count; i++) {
      if (data[i] === packet.value[i]) continue;
      data[i] |= packet.value[i];
      needUpdate = true;
    }

    if (!needUpdate) return;

    this.cDB.mumbo_token_flags = data;
    this.needDeleteActors = true;
    
    this.ModLoader.logger.info('[Client] Updated: {Mumbo Token Flags}');
  }

  @NetworkHandler('SyncNoteTotals')
  onClient_SyncNoteTotals(packet: Net.SyncBuffered) {
    this.ModLoader.logger.info('[Client] Received: {Note Totals}');

    let data: Buffer = this.cDB.note_totals;
    let count: number = data.byteLength;
    let i = 0;
    let needUpdate = false;

    for (i = 0; i < count; i++) {
      if (data[i] === packet.value[i]) continue;
      data[i] = Math.max(data[i], packet.value[i]);
      if (data[i] > 100) data[i] = 100;
      needUpdate = true;
    }

    if (!needUpdate) return;

    this.cDB.note_totals = data;

    this.ModLoader.logger.info('[Client] Updated: {Note Totals}');
  }

  @NetworkHandler('SyncJigsaws')
  onClient_SyncJigsaws(packet: Net.SyncBuffered) {
    this.ModLoader.logger.info('[Client] Received: {Jigsaws Completion}');

    let data: Buffer = this.cDB.jigsaws_completed;
    let count: number = data.byteLength;
    let i = 0;
    let needUpdate = false;

    for (i = 0; i < count; i++) {
      if (data[i] >= packet.value[i]) continue;
      if (packet.value[i] > 0) data[i] = 1;
      needUpdate = true;
    }

    if (!needUpdate) return;

    this.cDB.jigsaws_completed = data;

    this.ModLoader.logger.info('[Client] Updated: {Jigsaws Completion}');
  }

  @NetworkHandler('SyncLevelEvents')
  onClient_SyncLevelEvents(packet: Net.SyncNumbered) {
    this.ModLoader.logger.info('[Client] Received: {Level Events}');

    if (this.cDB.level_events === packet.value) return;
    this.cDB.level_events |= packet.value;

    this.ModLoader.logger.info('[Client] Updated: {Level Events}');
  }

  // Puppet Tracking

  @NetworkHandler('Request_Scene')
  onClient_RequestScene(packet: Packet) {
    if (this.core.runtime === undefined || !this.core.isPlaying) return;
    let pData = new Net.SyncLocation(packet.lobby, this.curLevel, this.curScene);
    this.ModLoader.clientSide.sendPacketToSpecificPlayer(pData, packet.player);
  }

  @NetworkHandler('SyncLocation')
  onClient_SyncLocation(packet: Net.SyncLocation) {
    let pMsg = 'Player[' + packet.player.nickname + ']';
    let lMsg = 'Level[' + API.LevelType[packet.level] + ']';
    let sMsg = 'Scene[' + API.SceneType[packet.scene] + ']';
    this.pMgr.changePuppetScene(packet.player, packet.scene);
    this.ModLoader.logger.info('[Client] Received: {Player Scene}');
    this.ModLoader.logger.info('[Client] Updated: ' + pMsg + ' to ' + sMsg + ' of ' + lMsg);
    
    if (packet.level === API.LevelType.UNKNOWN ||
        packet.scene === API.SceneType.UNKNOWN) return;
    
    this.check_db_instance(this.cDB, packet.level, packet.scene);
  }

  @NetworkHandler('SyncPuppet')
  onClient_SyncPuppet(packet: Net.SyncPuppet) {
    this.pMgr.handlePuppet(packet);
  }

  // Level Tracking

  @NetworkHandler('SyncJinjos')
  onClient_SyncJinjos(packet: Net.SyncLevelNumbered) {
    this.ModLoader.logger.info('[Client] Received: {Jinjo}');

    let level = packet.level;
    
    // Ensure we have this level/scene data!
    this.check_db_instance(this.cDB, level, 0);    

    let map = this.cDB.level_data[level];
    if (map.jinjos === packet.value) return;
    map.jinjos |= packet.value;
    
    // Mark we need to delete the note if in same scene!
    if (this.curLevel === packet.level) {
      this.needDeleteActors = true;
    }
    
    this.ModLoader.logger.info('[Client] Updated: {Jinjo}');
  }

  @NetworkHandler('SyncObjectNotes')
  onClient_SyncObjectNotes(packet: Net.SyncLevelNumbered) {
    this.ModLoader.logger.info('[Client] Received: {Level Note Count}');

    let level = packet.level;
    
    // Ensure we have this level/scene data!
    this.check_db_instance(this.cDB, level, 0);    

    let map = this.cDB.level_data[level];
    if (map.onotes >= packet.value) return;
    map.onotes = packet.value;

    this.ModLoader.logger.info('[Client] Updated: {Level Note Count}');
  }

  @NetworkHandler('SyncVoxelNotes')
  onClient_SyncVoxelNotes(packet: Net.SyncVoxelNotes) {
    this.ModLoader.logger.info('[Client] Received: {Level Note Count}');

    let level = packet.level;
    let scene = packet.scene;
    
    // Ensure we have this level/scene data!
    this.check_db_instance(this.cDB, level, scene);    

    let map = this.cDB.level_data[level].scene[scene];
    let i = 0;
    let needsUpdate = false;

    for (i = 0; i < packet.notes.length; i++) {
      if (!map.notes.includes(packet.notes[i])) {
        map.notes.push(packet.notes[i]);
        needsUpdate = true;
      }
    }

    if (!needsUpdate) return;

    // Mark we need to delete the note if in same scene!
    if (this.curScene === packet.scene) {
      this.needDeleteVoxels = true;
    }

    this.ModLoader.logger.info('[Client] Updated: {Level Note Count}');
  }
}
