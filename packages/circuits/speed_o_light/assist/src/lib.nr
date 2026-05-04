use dep::poseidon::poseidon2::Poseidon2;

// ---------------------------------------------------------------------------
// Core PRF - maps (seed, nonce) deterministically to a u64
// ---------------------------------------------------------------------------
fn prf(seed: Field, nonce: u32) -> u64 {
    Poseidon2::hash([seed, nonce as Field], 1) as u64
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
pub fn gen_glow_sequence(seed: Field) -> [u32; 136] {
    let mut seq: [u32; 136] = [0; 136];

    // Position 0: unconstrained, draw from full [0, 24]
    seq[0] = (prf(seed, 0) % 25) as u32;

    for i in 1..136 {
        let raw = (prf(seed, i) % 24) as u32; // [0, 23]
        let prev = seq[i - 1];
        seq[i] = if raw >= prev { raw + 1 } else { raw };
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
//   Nonces are offset by 500 to avoid any correlation with sequence 1.
// ---------------------------------------------------------------------------
pub fn gen_danger_sequence(seed: Field) -> [u32; 34] {
    // Initialise pool [0 .. 135]
    let mut pool: [u32; 136] = [0; 136];
    for i in 0..136 {
        pool[i] = i;
    }

    let mut result: [u32; 34] = [0; 34];

    for i in 0..34 {
        let remaining = (136 - i) as u64;
        let offset = (prf(seed, i + 500) % remaining) as u32;
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
// Returns both sequences for a given seed
// ---------------------------------------------------------------------------
#[export]
pub fn get_game_board(seed: Field) -> ([u32; 136], [u32; 34]) {
    let glow_order = gen_glow_sequence(seed); // the glow lights order
    let danger_indces = gen_danger_sequence(seed); // the danger sequence among the 136 indices

    (glow_order, danger_indces)
}
