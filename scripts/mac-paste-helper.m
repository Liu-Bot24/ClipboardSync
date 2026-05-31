#import <ApplicationServices/ApplicationServices.h>
#import <Cocoa/Cocoa.h>
#include <string.h>
#include <unistd.h>

static void printUsage(void) {
  fprintf(stderr, "usage: mac-paste-helper --frontmost | [--prompt] <bundle-id>\n");
}

static int printFrontmostApplication(void) {
  NSRunningApplication *app = [[NSWorkspace sharedWorkspace] frontmostApplication];
  if (app == nil) {
    printf("null\n");
    return 0;
  }

  NSDictionary *payload = @{
    @"platform": @"darwin",
    @"pid": @(app.processIdentifier),
    @"bundleId": app.bundleIdentifier ?: @"",
    @"name": app.localizedName ?: @"",
    @"role": @"",
    @"subrole": @"",
    @"roleDescription": @"",
    @"focusState": @"frontmost-only",
    @"canPaste": [NSNull null]
  };

  NSError *error = nil;
  NSData *json = [NSJSONSerialization dataWithJSONObject:payload options:0 error:&error];
  if (json == nil) {
    fprintf(stderr, "failed to encode frontmost application: %s\n", error.localizedDescription.UTF8String ?: "unknown");
    return 70;
  }
  fwrite(json.bytes, 1, json.length, stdout);
  fputc('\n', stdout);
  return 0;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc == 2 && strcmp(argv[1], "--frontmost") == 0) {
      return printFrontmostApplication();
    }

    BOOL promptForPermission = NO;
    int bundleArgIndex = 1;
    if (argc > 1 && strcmp(argv[1], "--prompt") == 0) {
      promptForPermission = YES;
      bundleArgIndex = 2;
    }

    if (argc <= bundleArgIndex || argv[bundleArgIndex] == NULL || argv[bundleArgIndex][0] == '\0') {
      printUsage();
      return 64;
    }

    NSString *bundleId = [NSString stringWithUTF8String:argv[bundleArgIndex]];
    NSArray<NSRunningApplication *> *apps = [NSRunningApplication runningApplicationsWithBundleIdentifier:bundleId];
    __block NSRunningApplication *app = apps.firstObject;
    if (app != nil) {
      [app activateWithOptions:NSApplicationActivateAllWindows];
    } else {
      NSURL *url = [[NSWorkspace sharedWorkspace] URLForApplicationWithBundleIdentifier:bundleId];
      if (url == nil) {
        fprintf(stderr, "target application not found: %s\n", argv[bundleArgIndex]);
        return 66;
      }
      NSWorkspaceOpenConfiguration *configuration = [NSWorkspaceOpenConfiguration configuration];
      configuration.activates = YES;
      dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
      __block NSError *launchError = nil;
      [[NSWorkspace sharedWorkspace] openApplicationAtURL:url
                                            configuration:configuration
                                        completionHandler:^(NSRunningApplication *application, NSError *error) {
                                          app = application;
                                          launchError = error;
                                          dispatch_semaphore_signal(semaphore);
                                        }];
      dispatch_semaphore_wait(semaphore, dispatch_time(DISPATCH_TIME_NOW, 3 * NSEC_PER_SEC));
      if (launchError != nil || app == nil) {
        fprintf(stderr, "failed to activate target application: %s\n", launchError.localizedDescription.UTF8String ?: "unknown");
        return 69;
      }
    }

    NSDictionary *trustOptions = @{(__bridge id)kAXTrustedCheckOptionPrompt: @(promptForPermission)};
    BOOL trusted = AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)trustOptions);
    for (int i = 0; !trusted && promptForPermission && i < 20; i++) {
      usleep(100000);
      NSDictionary *checkOptions = @{(__bridge id)kAXTrustedCheckOptionPrompt: @NO};
      trusted = AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)checkOptions);
    }
    if (!trusted) {
      fprintf(stderr, "accessibility permission required for mac-paste-helper\n");
      return 77;
    }

    usleep(180000);

    CGEventSourceRef source = CGEventSourceCreate(kCGEventSourceStateHIDSystemState);
    if (source == NULL) {
      fprintf(stderr, "failed to create CGEvent source\n");
      return 70;
    }

    const CGKeyCode vKey = 0x09;
    CGEventRef keyDown = CGEventCreateKeyboardEvent(source, vKey, true);
    CGEventRef keyUp = CGEventCreateKeyboardEvent(source, vKey, false);
    if (keyDown == NULL || keyUp == NULL) {
      fprintf(stderr, "failed to create keyboard events\n");
      if (keyDown != NULL) CFRelease(keyDown);
      if (keyUp != NULL) CFRelease(keyUp);
      CFRelease(source);
      return 70;
    }

    CGEventSetFlags(keyDown, kCGEventFlagMaskCommand);
    CGEventSetFlags(keyUp, kCGEventFlagMaskCommand);
    CGEventPost(kCGHIDEventTap, keyDown);
    usleep(20000);
    CGEventPost(kCGHIDEventTap, keyUp);

    CFRelease(keyDown);
    CFRelease(keyUp);
    CFRelease(source);
    return 0;
  }
}
