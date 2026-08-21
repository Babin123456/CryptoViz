import { KalynaEngine } from './kalyna/kalynaEngine';
import { KupynaEngine } from './kupyna/kupynaEngine';
import { BaseCipher } from './baseCipher';

export class CipherRegistry {
  private ciphers: Map<string, BaseCipher> = new Map();

  constructor() {
    this.register('kalyna', new KalynaEngine());
    this.register('kupyna', new KupynaEngine());
  }

  register(name: string, instance: BaseCipher): void {
    this.ciphers.set(name, instance);
  }

  get(name: string): BaseCipher | undefined {
    return this.ciphers.get(name);
  }
}

export const globalCipherRegistry = new CipherRegistry();
