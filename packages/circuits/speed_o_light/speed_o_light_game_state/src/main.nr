use dep::assist::{get_grid_sequence, GLOW_COUNT, tap};
// ---------------------------------------------------------------------------
// Main proof logic
// inputs:
//  seed: Field - random seed for generating grid sequence
//  tap_sequence: [tap; GLOW_COUNT] - array of tap structs representing player taps
//  danger_tap: tap - the danger tap that end the game
// ---------------------------------------------------------------------------
fn main(seed: pub Field, tap_sequence: [tap; GLOW_COUNT], danger_tap: tap) {
    // [CHECK 01] assert if the propogated entiries match the generated grid sequence
    let grid_sequence = get_grid_sequence(seed);
    for i in 0..GLOW_COUNT {
        assert(
            tap_sequence[i].grid_index == grid_sequence[i].index,
            "[ERR] Proof: tap index mismatch",
        );
        assert(
            tap_sequence[i].is_danger == grid_sequence[i].is_danger,
            "[ERR] Proof: danger status mismatch",
        );
    }

    // [CHECK 02] Validate danger tap by sequence position
    let pos = danger_tap.seq_pos;
    if (pos != 255) {
        // The grid at this position must be a danger tile (proven deterministic from seed)
        assert(
            grid_sequence[pos].is_danger,
            "[ERR] Proof: referenced sequence position is not a danger glow",
        );
        // The tap record at this position must confirm the player tapped it
        assert(
            tap_sequence[pos].is_tapped,
            "[ERR] Proof: danger tap position was not tapped by player",
        );
    }
}
