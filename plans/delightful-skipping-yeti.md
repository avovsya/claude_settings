# Plan: Clear + Extend Motion Recording Feature

## Overview

Add long-press behavior to the *2 button that clears old motion data before extending, with visual feedback.

**Behavior:**
- **Short press (< 350ms)**: Existing behavior - extend recording, keep any existing data in the extended section
- **Long press (≥ 350ms)**: Clear any old data beyond current length, then duplicate current recording

## Implementation Steps

### Step 1: Create LongPressButton Component

**File:** `Source/UI/LongPressButton.h` (new)

Reusable button with short-press and long-press callbacks:
- Timer-based detection (16ms interval, ~60fps)
- 350ms threshold for long-press
- Progressive ring animation during hold (expanding from edge, 20-30px beyond button)
- Distinct visual feedback for long-press activation (red/orange blink with glow)
- iOS haptic feedback on long-press activation

```cpp
class LongPressButton : public juce::Component, private juce::Timer
{
public:
    std::function<void()> onShortPress;
    std::function<void()> onLongPress;

    void setLongPressThresholdMs(int ms);  // Default 350ms

private:
    void mouseDown(const juce::MouseEvent&) override;
    void mouseUp(const juce::MouseEvent&) override;
    void timerCallback() override;
    void paint(juce::Graphics&) override;

    int64_t pressStartTime = 0;
    bool longPressTriggered = false;
    float holdProgress = 0.0f;  // 0.0 to 1.0 for ring animation
    bool showClearFeedback = false;  // For blink animation
};
```

### Step 2: Add clearEventsInRange to MotionRecording

**File:** `Source/MotionRecording.cpp`

Add method to clear events within a tick range (per-fader):

```cpp
void MotionRecording::clearEventsInRange(int64_t startTick, int64_t endTick)
{
    for (auto& [faderId, events] : faderMotionData)
    {
        events.erase(
            std::remove_if(events.begin(), events.end(),
                [startTick, endTick](const MotionEvent& e) {
                    return e.tick >= startTick && e.tick < endTick;
                }),
            events.end()
        );
    }
}
```

### Step 3: Add clearExisting Parameter to doubleRecordingLength

**File:** `Source/MotionProcessor.cpp`

Modify `doubleRecordingLength()` to accept optional clear parameter:

```cpp
struct DoubleResult {
    bool success;
    bool hadDataCleared;  // True if old data was present and cleared
};

DoubleResult MotionProcessor::doubleRecordingLength(bool clearExistingInNewSection = false)
{
    DoubleResult result{false, false};

    // Existing length check...
    int64_t currentLength = getRecordingLengthTicks();
    int64_t newLength = currentLength * 2;

    // Copy-on-write pattern (existing)
    MotionRecording* copy;
    {
        juce::SpinLock::ScopedLockType lock(motionDataLock);
        copy = new MotionRecording(*motionRecording);
    }

    // Check if data exists in the new section before clearing
    if (clearExistingInNewSection)
    {
        for (const auto& [faderId, events] : copy->faderMotionData)
        {
            for (const auto& event : events)
            {
                if (event.tick >= currentLength && event.tick < newLength)
                {
                    result.hadDataCleared = true;
                    break;
                }
            }
            if (result.hadDataCleared) break;
        }

        if (result.hadDataCleared)
            copy->clearEventsInRange(currentLength, newLength);
    }

    // Duplicate current range (existing logic)
    copy->duplicateRange(0, currentLength, currentLength);

    // Update length
    copy->setLengthTicks(newLength);

    // Atomic swap (existing pattern)
    {
        juce::SpinLock::ScopedLockType lock(motionDataLock);
        std::swap(motionRecording, copy);
    }
    publishSnapshot();

    // Defer deletion to message thread
    juce::MessageManager::callAsync([copy]() { delete copy; });

    result.success = true;
    return result;
}
```

### Step 4: Replace doubleButton with LongPressButton

**File:** `Source/PluginEditor.cpp`

Replace the existing TextButton with LongPressButton:

```cpp
// In header: std::unique_ptr<LongPressButton> doubleButton;

// In constructor:
doubleButton = std::make_unique<LongPressButton>("*2");
doubleButton->onShortPress = [this]() {
    processor.getMotionProcessor().doubleRecordingLength(false);
    updateRecordingLengthDisplay();
};
doubleButton->onLongPress = [this]() {
    auto result = processor.getMotionProcessor().doubleRecordingLength(true);
    updateRecordingLengthDisplay();
    if (result.hadDataCleared)
        doubleButton->showClearAnimation();  // Trigger blink
};
addAndMakeVisible(*doubleButton);
```

### Step 5: Implement Visual Feedback

**In LongPressButton::paint():**

1. **During hold (0-350ms)**: Draw expanding ring from button edge
   - Ring expands 0-30px beyond button bounds
   - Color transitions from button color to orange
   - Use easing for smooth animation

2. **On long-press activation**:
   - Brief red/orange flash with outer glow
   - Ring completes and pulses once
   - iOS: Trigger haptic feedback via native bridge

```cpp
void LongPressButton::paint(juce::Graphics& g)
{
    // Base button drawing...

    if (holdProgress > 0.0f && !longPressTriggered)
    {
        // Progressive ring during hold
        float ringRadius = getWidth() * 0.5f + holdProgress * 30.0f;
        float ringThickness = 3.0f;
        g.setColour(juce::Colour::fromHSV(0.08f, 0.8f, 0.9f, holdProgress * 0.8f));
        g.drawEllipse(getLocalBounds().toFloat().expanded(holdProgress * 30.0f), ringThickness);
    }

    if (showClearFeedback)
    {
        // Red/orange glow flash
        g.setColour(juce::Colours::orangered.withAlpha(clearFeedbackAlpha));
        g.fillEllipse(getLocalBounds().toFloat().expanded(20.0f));
    }
}
```

## Files Modified

| File | Change |
|------|--------|
| `Source/UI/LongPressButton.h` | New - Reusable long-press button component |
| `Source/UI/LongPressButton.cpp` | New - Implementation |
| `Source/MotionRecording.h` | Add `clearEventsInRange()` declaration |
| `Source/MotionRecording.cpp` | Add `clearEventsInRange()` implementation |
| `Source/MotionProcessor.h` | Add `DoubleResult` struct, update `doubleRecordingLength()` signature |
| `Source/MotionProcessor.cpp` | Add clear logic to `doubleRecordingLength()` |
| `Source/PluginEditor.h` | Change `doubleButton` type to `LongPressButton` |
| `Source/PluginEditor.cpp` | Replace button, add short/long press handlers |

## Thread Safety

- **MotionProcessor**: Existing copy-on-write pattern maintained
- **clearEventsInRange**: Called on copy before atomic swap (safe)
- **Visual feedback**: All on message thread (safe)

## Testing

1. **Short press**: Verify existing extend behavior preserved
2. **Long press with no old data**: Should duplicate, no flash
3. **Long press with old data**: Should clear + duplicate, flash animation
4. **Timing**: Verify 350ms threshold feels natural
5. **Visual**: Ring expands during hold, completes on activation
6. **iOS**: Haptic feedback triggers on long-press
