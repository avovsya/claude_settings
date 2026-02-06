# Scrub Wheel Improvements Plan

## Overview

Two major improvements to the tape wheel scrubbing system:
1. **Audio Quality** - Fix metallic artifacts with better interpolation
2. **Wheel Physics** - Fixed rotation-to-time mapping with realistic inertia/friction

---

## Research Summary

### Audio Quality Issues (Current)
- **Linear interpolation** has only -13dB stopband attenuation
- Causes aliasing artifacts described as "metallic" or "harsh"
- Gets worse at extreme pitch ratios (fast/slow scrubbing)

### CDJ/Vinyl Standard (Research Finding)
- **1 full rotation = 1.8 seconds** of audio at normal speed
- This matches vinyl records at 33⅓ RPM (industry standard)
- Used by Pioneer CDJ, Serato, Traktor, and likely TP-7

---

## Part 1: Audio Quality Fix

### Solution: Hermite Interpolation

Replace linear interpolation with **4-point Hermite (Catmull-Rom)**:

| Aspect | Linear (Current) | Hermite (New) |
|--------|-----------------|---------------|
| Stopband attenuation | -13dB | -40dB |
| Samples used | 2 | 4 |
| CPU cost | 1x | ~4x (still fast) |
| Sound quality | Metallic, harsh | Smooth, natural |

### Files to Modify

**AudioUtilities.h/.cpp** - Add new interpolation:
```cpp
static float hermiteInterpolate(float y0, float y1, float y2, float y3, float fraction)
{
    float c0 = y1;
    float c1 = 0.5f * (y2 - y0);
    float c2 = y0 - 2.5f * y1 + 2.0f * y2 - 0.5f * y3;
    float c3 = 0.5f * (y3 - y0) + 1.5f * (y1 - y2);
    return ((c3 * fraction + c2) * fraction + c1) * fraction + c0;
}
```

**PlaybackEngine.cpp** - Update `processScrubPlayback()` to use Hermite with 4 surrounding samples.

---

## Part 2: Wheel Physics Redesign

### Current Behavior (Problem)
- 1 rotation = entire recording length (variable)
- Same wheel speed produces different audio speeds depending on recording length
- Position-based system (0.0-1.0 normalized)

### New Behavior (Solution)
- **1 rotation = 1.8 seconds** of audio (fixed, like CDJ/vinyl)
- Same wheel speed always produces same audio speed
- Velocity-based system with proper physics
- Multiple rotations possible, loops at buffer boundaries

### Physics Parameters (Internal, Configurable)

| Parameter | Default | Description |
|-----------|---------|-------------|
| `SECONDS_PER_ROTATION` | 1.8f | Audio time per wheel rotation |
| `wheelMass` | 1.0f | Affects acceleration feel (0.1-5.0) |
| `wheelFriction` | 0.92f | Momentum decay rate (0.5-0.99) |
| `wheelDrag` | 0.02f | Velocity-dependent resistance |

### Key Formula
```
samples_per_rotation = SECONDS_PER_ROTATION * sampleRate
audio_velocity = angular_velocity * samples_per_rotation / (2 * PI)
```

### Buffer Looping
When position reaches 0.0 or 1.0, wrap around:
```cpp
position = fmod(position + delta + 1.0f, 1.0f);
```

---

## Implementation Tasks

### Task 1: Add Hermite Interpolation to AudioUtilities
**File:** `Source/AudioUtilities.h` and `Source/AudioUtilities.cpp`
- Add `hermiteInterpolate(y0, y1, y2, y3, fraction)` function
- Add `readSampleHermite()` that reads 4 surrounding samples with buffer wrapping

### Task 2: Update PlaybackEngine Scrub Processing
**File:** `Source/PlaybackEngine.h` and `Source/PlaybackEngine.cpp`
- Replace linear interpolation with Hermite in `processScrubPlayback()`
- Add `SECONDS_PER_ROTATION` constant (1.8f)
- Change position calculation to use fixed time-per-rotation
- Handle buffer looping (wrap at boundaries)

### Task 3: Redesign TapeWheelDisplay Physics
**File:** `Source/TapeWheelDisplay.h` and `Source/TapeWheelDisplay.cpp`
- Add physics parameters: `wheelMass`, `wheelFriction`, `wheelDrag`
- Track `angularVelocity` (radians/second) instead of position delta
- Report velocity to listeners (samples/second), not normalized position
- Implement proper momentum physics in `timerCallback()`
- Remove dependency on recording length for rotation mapping

### Task 4: Update Listener Interface
**File:** `Source/TapeWheelDisplay.h`
- Change `scrubPositionChanged(float position)` to report buffer position
- Keep `scrubVelocityChanged(float velocity)` for audio speed

### Task 5: Update PluginEditor Connection
**File:** `Source/PluginEditor.cpp`
- Update to work with new velocity-based system
- Handle position updates from PlaybackEngine for visual sync

---

## Constants

```cpp
// TapeWheelDisplay.h
static constexpr float SECONDS_PER_ROTATION = 1.8f;   // CDJ/vinyl standard
static constexpr float DEFAULT_WHEEL_MASS = 1.0f;     // Affects acceleration
static constexpr float DEFAULT_WHEEL_FRICTION = 0.92f; // Momentum decay
static constexpr float DEFAULT_WHEEL_DRAG = 0.02f;    // Velocity drag
static constexpr float MIN_ANGULAR_VELOCITY = 0.001f; // Stop threshold
```

---

## Verification

### Build Test
```bash
cd ~/src/tape_vst_v1
./Scripts/build.sh
```

### Functional Tests
1. **Audio Quality**: Scrub through audio - should sound smooth, not metallic
2. **Consistent Speed**: Same wheel rotation speed = same audio speed (regardless of recording length)
3. **Physics Feel**: Release wheel while spinning - should coast with momentum
4. **Looping**: Scrub past buffer end - should loop to beginning (and vice versa)
5. **Bidirectional**: Scrub backwards - should play audio in reverse

### Quality Comparison
- Record a voice or music sample
- Scrub slowly - should hear clear audio without harsh artifacts
- Scrub quickly - should hear sped-up audio, still smooth
- Compare before/after the Hermite interpolation change

---

## Files Summary

| File | Changes |
|------|---------|
| `Source/AudioUtilities.h` | Add `hermiteInterpolate()` declaration |
| `Source/AudioUtilities.cpp` | Add `hermiteInterpolate()` implementation |
| `Source/PlaybackEngine.h` | Add `SECONDS_PER_ROTATION` constant |
| `Source/PlaybackEngine.cpp` | Use Hermite, fixed time mapping, buffer looping |
| `Source/TapeWheelDisplay.h` | New physics parameters, velocity-based system |
| `Source/TapeWheelDisplay.cpp` | New physics simulation, angular velocity tracking |
| `Source/PluginEditor.cpp` | Update listener callbacks for new system |
