/**
 * Speakable room codes, e.g. "HILL-SHOE-RING": easy to read over the phone, hard to mistype.
 * Three words from a 117-word list (~1.6M combinations, crypto-random). Joining a room only makes
 * devices visible to each other; every transfer still needs the receiver's explicit Accept.
 */
const WORDS = [
  'BLUE', 'RED', 'GREEN', 'GOLD', 'PINK', 'GRAY', 'FOX', 'OWL', 'CAT', 'DOG', 'BEAR', 'DEER',
  'DUCK', 'FROG', 'LION', 'SEAL', 'SWAN', 'WOLF', 'MOON', 'STAR', 'SUN', 'RAIN', 'SNOW',
  'WIND', 'LAKE', 'HILL', 'TREE', 'LEAF', 'ROSE', 'PINE', 'SAND', 'WAVE', 'BOAT', 'KITE',
  'BELL', 'DRUM', 'LAMP', 'DOOR', 'CUP', 'HAT', 'BOOK', 'CAKE', 'PEAR', 'PLUM', 'LIME', 'CORN',
  'MINT', 'TEA', 'SOFA', 'BED', 'SHOE', 'COAT', 'RING', 'COIN', 'KEY', 'MAP', 'SHIP', 'TRAIN',
  'BIRD', 'FISH', 'HAWK', 'MOTH', 'CLAY', 'FERN', 'APPLE', 'BREAD', 'CHAIR', 'CLOCK', 'CLOUD',
  'DAISY', 'EAGLE', 'FLAME', 'GRAPE', 'HORSE', 'LEMON', 'MANGO', 'NIGHT', 'OCEAN', 'PANDA',
  'PIANO', 'RIVER', 'SHEEP', 'SPOON', 'TIGER', 'TOWER', 'WHALE', 'ZEBRA', 'ANT', 'BEE', 'COW',
  'CROW', 'EGG', 'ELK', 'FIG', 'HEN', 'JAR', 'LOG', 'NUT', 'PIG', 'PIE', 'RUG', 'SKY', 'TOY',
  'VAN', 'WEB', 'YAK', 'ZOO', 'BAG', 'BOX', 'CAP', 'FAN', 'GEM', 'ICE', 'JAM', 'MUD', 'OAK',
  'PAN',
];

function rand(n: number): number {
  const b = new Uint32Array(1);
  crypto.getRandomValues(b);
  return b[0]! % n;
}

export function makeRoomCode(): string {
  return [0, 1, 2].map(() => WORDS[rand(WORDS.length)]!).join('-');
}
