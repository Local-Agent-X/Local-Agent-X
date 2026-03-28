/**
 * Smart Home Mission Pack — IoT control missions.
 */

import type { Mission } from "../../missions.js";

export const lightControlMission: Mission = {
  name: "smart_lights",
  description: "Control smart lights: on/off, brightness, color, scenes across rooms.",
  triggers: ["turn on lights", "turn off lights", "set lights", "change light color", "dim lights", "lights on", "lights off"],
  learnablePreferences: ["light_platform", "room_names", "favorite_scenes", "default_brightness"],
  rules: [
    "Identify the target platform (Hue, LIFX, Home Assistant, etc.) from preferences.",
    "Use room names the user has configured, not generic ones.",
    "For color changes, accept common color names and hex codes.",
    "Scenes should be applied atomically — all lights in a scene change together.",
    "Confirm the action taken after execution.",
  ],
  steps: [
    { id: "parse_request", instruction: "Parse what the user wants: which lights, what action, which room." },
    { id: "identify_devices", instruction: "Match room/light names to actual device IDs." },
    { id: "execute", instruction: "Send the command to the smart home API." },
    { id: "confirm", instruction: "Confirm the lights responded correctly.", validate: "Devices report expected state" },
  ],
};

export const thermostatMission: Mission = {
  name: "smart_thermostat",
  description: "Control thermostat: set temperature, mode, schedule.",
  triggers: ["set temperature", "change thermostat", "set ac", "set heating", "make it warmer", "make it cooler"],
  learnablePreferences: ["thermostat_platform", "preferred_temp_unit", "comfort_range", "schedule_preferences"],
  rules: [
    "Always confirm temperature unit (°F or °C) from preferences.",
    "Warn if setting temperature outside comfort range.",
    "Show current temperature before making changes.",
    "For schedule changes, show before and after.",
  ],
  steps: [
    { id: "get_current", instruction: "Read current temperature and thermostat mode." },
    { id: "parse_request", instruction: "Determine target temperature, mode (heat/cool/auto), and schedule changes." },
    { id: "confirm_change", instruction: "Show current → desired change. Get approval for extreme changes.", requiresUserAction: true },
    { id: "execute", instruction: "Send the command to the thermostat." },
    { id: "verify", instruction: "Confirm the thermostat accepted the new setting.", validate: "Thermostat reports new target temperature" },
  ],
};

export const securityMission: Mission = {
  name: "smart_security",
  description: "Control smart home security: arm/disarm alarm, check cameras, lock/unlock doors.",
  triggers: ["arm alarm", "disarm alarm", "check cameras", "lock doors", "unlock door", "security status"],
  learnablePreferences: ["security_platform", "camera_names", "default_arm_mode"],
  rules: [
    "Security actions ALWAYS require explicit user confirmation.",
    "Never disarm without verifying user identity intent.",
    "Show camera feeds as snapshots when checking cameras.",
    "Log all security actions with timestamps.",
    "For door locks, confirm which specific door.",
  ],
  steps: [
    { id: "parse_request", instruction: "Determine security action: arm, disarm, check cameras, lock/unlock." },
    { id: "get_status", instruction: "Get current security system status." },
    { id: "confirm", instruction: "Show current status and intended change. Require explicit confirmation.", requiresUserAction: true },
    { id: "execute", instruction: "Execute the security command." },
    { id: "verify", instruction: "Verify the system is in the expected state.", validate: "Security system reports expected state" },
    { id: "log", instruction: "Log the action with timestamp for audit trail." },
  ],
};

export const sceneMission: Mission = {
  name: "smart_scene",
  description: "Activate smart home scenes that control multiple devices at once (movie night, bedtime, away, etc.).",
  triggers: ["movie night", "bedtime mode", "away mode", "activate scene", "good morning", "good night"],
  learnablePreferences: ["scene_platform", "custom_scenes", "morning_routine", "night_routine"],
  rules: [
    "Scenes can span lights, thermostat, blinds, TV, and speakers.",
    "Show what devices will be affected before activating a scene.",
    "Custom scenes should be saveable for future use.",
    "For 'away mode': arm security, adjust thermostat, turn off lights.",
  ],
  steps: [
    { id: "identify_scene", instruction: "Match user request to a predefined or custom scene." },
    { id: "preview", instruction: "List all devices and actions in the scene." },
    { id: "confirm", instruction: "Get user approval to activate.", requiresUserAction: true },
    { id: "execute", instruction: "Activate the scene — send commands to all devices." },
    { id: "verify", instruction: "Check that all devices responded.", validate: "All scene devices report expected state" },
  ],
};

export const smarthomeMissions: Mission[] = [
  lightControlMission,
  thermostatMission,
  securityMission,
  sceneMission,
];
