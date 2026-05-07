use dep::poseidon::poseidon2::Poseidon2;

pub global GLOW_COUNT: u32 = 136; // total no. of tile glows in a session
pub global DANGER_COUNT: u32 = 34; // total no. of danger glows in a session: 0.25 * GLOW_COUNT
pub global GRID_COUNT: u32 = 25; //  total no. of tiles in the grid

#[export]
pub struct tile { // representation of a glowing tile in the grid
    pub index: u32, // the grid level index: [0-24]
    pub is_danger: bool, // wether the tile should glow in danger or normal mode
}

#[export]
pub struct tap { // captured tile tap data from client
    pub seq_pos: u32, // sequence position [0,135], or 255 no danger tap
    pub is_danger: bool, // wether the tile was in danger or normal mode
    pub is_tapped: bool, // wether the tile was tapped by the user
}

// ---------------------------------------------------------------------------
// Core PRF - maps (seed, nonce) deterministically to a u64
// ---------------------------------------------------------------------------
fn prf_domain(seed: Field, domain: Field, nonce: u32) -> Field {
    Poseidon2::hash([seed, domain, nonce as Field], 1)
}

// ---------------------------------------------------------------------------
// Sequence 1: 136 values in [0, 24], no consecutive duplicates
//
// Strategy - "skip-over bijection" :
//   1. Draw raw in [0, 23]  (24 values = full range minus one slot)
//   2. If raw >= prev, return raw + 1  ->  lands in [prev+1, 24]
//      Else                return raw   ->  lands in [0, prev-1]
//   Maps [0,23] bijectively onto [0,24] \ {prev}, uniform by construction.
// ---------------------------------------------------------------------------
pub fn gen_glow_sequence(seed: Field) -> [u32; GLOW_COUNT] {
    let mut seq: [u32; GLOW_COUNT] = [0; GLOW_COUNT];

    // Position 0: unconstrained, draw from full [0, 24]
    seq[0] = (prf_domain(seed, 0, 0) as u32) % GRID_COUNT;

    for i in 1..GLOW_COUNT {
        let raw_field = (prf_domain(seed, 0, i) as u32) % (GRID_COUNT - 1);
        let raw = raw_field as u32;
        let prev = seq[i - 1];
        let step: u32 = (raw >= prev) as u32; // 1 if raw >= prev, else 0
        seq[i] = raw + step;
    }

    seq
}

// ---------------------------------------------------------------------------
// Sequence 2: 34 distinct values in [0, 135]
//
// Strategy - partial Fisher-Yates shuffle:
//   Start with pool = [0, 1, ... 135].
//   For each output position i (0..34):
//     Pick a random index j in [i, 135]  (i.e. offset = hash % (136 - i))
//     Swap pool[i] with pool[j]
//     Emit pool[i]
//   Uniqueness is guaranteed because each value can only appear once in pool.
// ---------------------------------------------------------------------------
pub fn gen_danger_sequence(seed: Field) -> [u32; DANGER_COUNT] {
    // Initialise pool [0 .. 135]
    let mut pool: [u32; 136] = [0; 136];
    for i in 0..136 {
        pool[i] = i;
    }

    let mut result: [u32; DANGER_COUNT] = [0; DANGER_COUNT];

    for i in 0..DANGER_COUNT {
        let remaining = (136 - i) as u32;
        let offset = (prf_domain(seed, 1, i) as u32) % remaining;
        let j = i + offset;

        // Swap pool[i] <-> pool[j]
        let tmp = pool[i];
        pool[i] = pool[j];
        pool[j] = tmp;

        result[i] = pool[i];
    }

    result
}

// ---------------------------------------------------------------------------
// Gaming grid with glow and danger sequences
//
// use the seed to generate glow and danger sequences, then combine them into a grid
// input:
//  seed: Field -> random seed value from thrid party provider
// output:
//  [tile; GLOW_COUNT] -> array of tile structs representing the glowing grid sequence
// exported for use via typescript codegen in the typescript based backend
// ---------------------------------------------------------------------------
#[export]
pub fn get_grid_sequence(seed: Field) -> [tile; GLOW_COUNT] {
    let glow_sequence = gen_glow_sequence(seed);
    let danger_sequence = gen_danger_sequence(seed);

    let tile_default = tile { index: 255, is_danger: false };

    let mut grid_sequence: [tile; GLOW_COUNT] = [tile_default; GLOW_COUNT];
    for i in 0..GLOW_COUNT {
        grid_sequence[i].index = glow_sequence[i];
    }

    for i in 0..DANGER_COUNT {
        let index = danger_sequence[i];
        grid_sequence[index].is_danger = true;
    }

    grid_sequence
}
