# Plan: Stop Motion Playback Button

## Summary

Add a toggle button to pause/resume motion playback independent of transport state. When paused, faders freeze at their current position. Motion tick continues advancing so playback resumes from the correct position when unpaused.

## Approach: Separate Atomic Flag

Use a `std::atomic<bool> motionPlaybackPaused` flag in MotionProcessor, independent of FaderMode. This allows:
- Pausing motion while in any mode (None, Record, Clear, Hold)
- Recording new motion while playback is paused
- Transport to continue running (useful for live performance)

## Files to Modify

### 1. MotionProcessor.h
Add atomic flag and accessors:
```cpp
public:
    void setMotionPlaybackPaused(bool paused);
    bool isMotionPlaybackPaused() const;

private:
    std::atomic<bool> motionPlaybackPaused{false};
```

### 2. MotionProcessor.cpp
- Add setter implementation (atomic store)
- Modify `processFader()` value selection (~line 232): when paused and not activated, use current fader value `Vf` instead of motion value `Vt` (freezes faders in place)

### 3. PluginEditor.h
Add button member:
```cpp
juce::TextButton stopMotionButton;
```

### 4. PluginEditor.cpp
- **Constructor**: Initialize button with toggle behavior, onClick callback calls `audioProcessor.getMotionProcessor()->setMotionPlaybackPaused()`
- **resized()**: Position in left sidebar above HOLD button

### 5. LookAndFeel.cpp
- Add icon handling in `drawButtonText()` for stopMotionButton
- Show pause icon (||) when playing, play icon when paused

### 6. AppConfigurator.h/cpp
- Add `showStopMotionButton` UIConfiguration flag
- Enable in Default profile

## Implementation Order

1. MotionProcessor.h/cpp - Core pause logic
2. PluginEditor.h/cpp - Button UI
3. LookAndFeel.cpp - Icon rendering
4. AppConfigurator.h/cpp - Visibility flag

## Edge Cases

- **No motion data**: Button works, just no visible effect
- **Scene change while paused**: Pause state persists
- **Recording while paused**: Records to buffer normally
- **Transport stop**: Pause state independent, resumes correctly

## Verification

1. Build: `./Scripts/build.sh`
2. Launch standalone app
3. Test: Record some motion, press stop button, verify faders freeze
4. Test: Unpause, verify motion resumes from correct position
5. Test: Pause while recording, verify recording continues
