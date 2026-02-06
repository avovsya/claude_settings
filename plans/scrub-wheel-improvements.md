# Scrub Wheel Improvements Plan

## Overview

Two major improvements to the tape wheel scrubbing system:
1. **Audio Quality** - Fix metallic artifacts with better interpolation and tape-like processing
2. **Wheel Physics** - Fixed rotation-to-time mapping with realistic inertia/friction

---

## Part 1: Audio Quality Improvements

### Problem Analysis

Current implementation uses **linear interpolation** which has:
- Only -13dB stopband attenuation (very poor)
- Causes aliasing artifacts described as "metallic" or "harsh"
- Poor high-frequency reconstruction
- Gets worse at extreme pitch ratios

### Solution: Multi-Stage Improvement

#### Stage 1: Upgrade Interpolation (High Priority)

Replace linear interpolation with **4-point Hermite (Catmull-Rom)** interpolation:
- ~40dB stopband attenuation (major improvement)
- CPU cost: ~4x linear (still very fast)
- Quality suitable for professional production

**Implementation in AudioUtilities.h/.cpp:**
```cpp
// Add new interpolation method
static float hermiteInterpolate(float y0, float y1, float y2, float y3, float fraction)
{
    float c0 = y1;
    float c1 = 0.5f * (y2 - y0);
    float c2 = y0 - 2.5f * y1 + 2.0f * y2 - 0.5f * y3;
    float c3 = 0.5f * (y3 - y0) + 1.5f * (y1 - y2);
    return ((c3 * fraction + c2) * fraction + c1) * fraction + c0;
}
```

#### Stage 2: Anti-Aliasing Filter (Medium Priority)

When scrubbing fast (velocity > 1.0x), add lowpass filter before output:
- Cutoff frequency = Nyquist / abs(velocity)
- Use simple IIR biquad (low CPU cost)
- Prevents high frequencies from aliasing when "speeding up"

#### Stage 3: Tape Character (Optional Enhancement)

Add subtle tape-like effects during scrubbing:
- **Wow**: 0.5 Hz, 0.1-0.3% depth (subtle pitch wobble)
- **Flutter**: 8-20 Hz, 0.02-0.1% depth (faster wobble)
- **Soft saturation**: Gentle tanh(x) or similar for warmth

---

## Part 2: Wheel Physics Improvements

### Research Findings

**CDJ/Vinyl Standard:**
- **1 full rotation = 1.8 seconds** of audio at 1x speed
- This matches vinyl records at 33 1/3 RPM (60/33.33 = 1.8)
- Industry standard used by Pioneer CDJ, Serato, Traktor

**TP-7 Behavior (inferred):**
- Likely uses similar mapping for familiar feel
- Has magnetic/hall sensor wheel with some resistance
- Provides haptic feedback

### Solution: Redesigned Wheel System

#### Change 1: Fixed Rotation-to-Time Mapping

**Current behavior:**
- 1 rotation = entire recording length (variable)
- Spinning at same speed produces different audio speeds

**New behavior:**
- 1 rotation = 1.8 seconds of audio (fixed, configurable)
- Spinning at same speed always produces same audio speed
- Multiple rotations possible for longer recordings
- Loops at buffer boundaries (forwards or backwards)

**Key Formula:**
```
audio_position_delta = (angle_delta / 2π) * SECONDS_PER_ROTATION * sample_rate
```

Where `SECONDS_PER_ROTATION = 1.8` by default.

#### Change 2: Wheel Physics Engine

Add realistic physics simulation:

**Parameters (internally configurable):**
| Parameter | Default | Range | Description |
|-----------|---------|-------|-------------|
| `wheelMass` | 1.0 | 0.1-5.0 | Simulated wheel weight (affects acceleration) |
| `wheelFriction` | 0.92 | 0.5-0.99 | Friction coefficient (how fast it slows down) |
| `wheelDrag` | 0.02 | 0.0-0.2 | Air resistance (velocity-dependent slowdown) |

**Physics Equations:**
```
// During drag (user is touching wheel)
angular_velocity = (angle_delta / time_delta)

// During momentum (user released wheel)
angular_velocity = angular_velocity * friction - drag * angular_velocity^2
angular_position += angular_velocity * time_delta

// Stop threshold
if (abs(angular_velocity) < MIN_VELOCITY) stop()
```

#### Change 3: Buffer Looping

When scrubbing reaches buffer boundaries:
- **Loop mode**: Wrap around to other end (continuous scrubbing)
- Position wraps: `position = fmod(position + delta + 1.0, 1.0)`

---

## Implementation Plan

### Files to Modify

1. **AudioUtilities.h/.cpp** - Add Hermite interpolation
2. **PlaybackEngine.h/.cpp** - Update scrub processing
3. **TapeWheelDisplay.h/.cpp** - New physics system and rotation mapping

### Step-by-Step Tasks

#### Task 1: Add Hermite Interpolation to AudioUtilities
- Add `hermiteInterpolate()` function
- Add `readSampleHermite()` that reads 4 surrounding samples
- Handle buffer wrapping for all 4 sample points

#### Task 2: Update PlaybackEngine Scrub Processing
- Replace linear interpolation with Hermite in `processScrubPlayback()`
- Change from position-based to velocity-based audio output
- Audio velocity = wheel angular velocity * (SECONDS_PER_ROTATION / 2π) * sampleRate
- Handle buffer looping (wrap position when reaching boundaries)

#### Task 3: Redesign TapeWheelDisplay Physics
- Remove old position-based system
- Add new physics state: `angularVelocity`, `angularPosition`
- Add configurable parameters: `wheelMass`, `wheelFriction`, `wheelDrag`
- Implement proper physics simulation in `timerCallback()`
- Report angular velocity (not position) to listeners
- One rotation = 1.8 seconds constant (not dependent on recording length)

#### Task 4: Update PluginEditor Connection
- Update listener interface if needed
- Ensure smooth handoff between drag and momentum phases

#### Task 5: Testing
- Test scrubbing quality with various audio content
- Test physics feel (heavy vs light wheel)
- Test boundary looping (forward and backward)
- Test extreme speeds (fast spinning, slow spinning)

---

## Configuration Constants

```cpp
// TapeWheelDisplay.h
static constexpr float SECONDS_PER_ROTATION = 1.8f;  // CDJ/vinyl standard
static constexpr float DEFAULT_WHEEL_MASS = 1.0f;    // Affects acceleration feel
static constexpr float DEFAULT_WHEEL_FRICTION = 0.92f; // Momentum decay
static constexpr float DEFAULT_WHEEL_DRAG = 0.02f;   // Velocity-dependent drag
static constexpr float MIN_ANGULAR_VELOCITY = 0.001f; // Stop threshold
```

---

## Audio Quality Comparison

| Aspect | Current (Linear) | Improved (Hermite) |
|--------|-----------------|-------------------|
| Stopband attenuation | -13dB | -40dB |
| High frequency retention | Poor | Good |
| Aliasing artifacts | Severe | Minimal |
| CPU cost | 1x | 4x |
| Sound character | Metallic, harsh | Smooth, natural |

---

## Expected Results

After implementation:
1. **Sound quality**: Smooth, tape-like scrubbing without metallic artifacts
2. **Consistent feel**: Same wheel speed = same audio speed regardless of recording length
3. **Natural physics**: Wheel feels like it has weight and momentum
4. **Seamless looping**: Can scrub continuously in either direction

---

## Future Enhancements (Not in This Plan)

- Wow/flutter effects during scrubbing
- Tape saturation/warmth
- Configurable wheel weight via UI
- Touch-sensitive velocity adjustment
