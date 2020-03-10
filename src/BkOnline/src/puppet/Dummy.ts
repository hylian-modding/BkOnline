import { INetworkPlayer } from 'modloader64_api/NetworkHandler';

export class Dummy implements INetworkPlayer {
    nickname = 'Dummy';
    uuid: string = 'Dummy';

    isSamePlayer(compare: INetworkPlayer): boolean {
        return this.nickname === compare.nickname && this.uuid === compare.uuid;
    }
}

export const dummy: Dummy = new Dummy();