import { INetworkPlayer } from 'modloader64_api/NetworkHandler';
import uuid = require('uuid');

export class Dummy implements INetworkPlayer {
    nickname = 'Dummy';
    uuid: string = uuid.v4();

    isSamePlayer(compare: INetworkPlayer): boolean {
        return this.nickname === compare.nickname && this.uuid === compare.uuid;
    }
}

export const dummy: Dummy = new Dummy();