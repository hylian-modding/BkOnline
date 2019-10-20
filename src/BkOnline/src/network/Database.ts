export class Database {
    game_flags: Buffer = Buffer.alloc(0x20);
    honeycomb_flags: Buffer = Buffer.alloc(0x03);
    jiggy_flags: Buffer = Buffer.alloc(0x0d);
    mumbo_token_flags: Buffer = Buffer.alloc(0x10);
    note_totals: Buffer = Buffer.alloc(0x0f);
    jigsaws_completed: Buffer = Buffer.alloc(11);
    level_data: any = {};
    level_events: number = 0;
    moves: number = 0;
}

export class DatabaseClient extends Database {
    inst_refresh_state: number = 0;
}

export class DatabaseServer extends Database {
    // Puppets
    playerInstances: any = {};
    players: any = {};
}

export class LevelData {
    // Main
    scene: any = {};
    onotes: number = 0;
    jinjos: number = 0;

    // Level Specific
    orange: number = 0;
    gold_bullion: number = 0;
    present_blue: number = 0;
    present_red: number = 0;
    present_green: number = 0;
}

export class SceneData {
    notes: number[] = new Array<number>();
    events: number = 0;
}