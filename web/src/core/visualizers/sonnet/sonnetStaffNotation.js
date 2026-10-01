// 机械移植自 chthollyphile/folia-major src/components/visualizer/sonnet/sonnetStaffNotation.ts @ 41 行

// La Folia's public-domain D-minor theme, transcribed from its 3/4 LilyPond notation.
export const LA_FOLIA_STAFF_NOTES = [
    { pitch: 'D5', staffStep: 6, beats: 1 },
    { pitch: 'D5', staffStep: 6, beats: 1.5 },
    { pitch: 'E5', staffStep: 7, beats: 0.5 },
    { pitch: 'C#5', staffStep: 5, beats: 1, accidental: 'sharp' },
    { pitch: 'C#5', staffStep: 5, beats: 1, accidental: 'sharp' },
    { pitch: 'C#5', staffStep: 5, beats: 1, accidental: 'sharp' },
    { pitch: 'D5', staffStep: 6, beats: 1 },
    { pitch: 'D5', staffStep: 6, beats: 1.5 },
    { pitch: 'D5', staffStep: 6, beats: 0.5 },
    { pitch: 'E5', staffStep: 7, beats: 1 },
    { pitch: 'E5', staffStep: 7, beats: 1 },
    { pitch: 'E5', staffStep: 7, beats: 1 },
    { pitch: 'F5', staffStep: 8, beats: 1 },
    { pitch: 'F5', staffStep: 8, beats: 1.5 },
    { pitch: 'F5', staffStep: 8, beats: 0.5 },
    { pitch: 'E5', staffStep: 7, beats: 1 },
    { pitch: 'E5', staffStep: 7, beats: 1 },
    { pitch: 'E5', staffStep: 7, beats: 1 },
    { pitch: 'D5', staffStep: 6, beats: 1 },
    { pitch: 'D5', staffStep: 6, beats: 1.5 },
    { pitch: 'C#5', staffStep: 5, beats: 0.5, accidental: 'sharp' },
    { pitch: 'D5', staffStep: 6, beats: 3 },
];

export const LA_FOLIA_TOTAL_BEATS = LA_FOLIA_STAFF_NOTES.reduce(
    (total, note) => total + note.beats,
    0,
);

export const LA_FOLIA_CYCLE_SECONDS = 8;
