
#ifndef MEETING_SDK_LINUX_SAMPLE_MEETINGSHARECTRLEVENT_H
#define MEETING_SDK_LINUX_SAMPLE_MEETINGSHARECTRLEVENT_H

#include "meeting_service_components/meeting_sharing_interface.h"

using namespace std;
using namespace ZOOMSDK;

/**
 * Share-controller event listener.
 *
 * Only onSharingStatus and onFailedToStartShare carry signal for the
 * screen-share spike — they tell us whether the SDK accepted the share start
 * (Sharing_Self_Send_Begin) or rejected it (onFailedToStartShare). Everything
 * else is stubbed, mirroring MeetingRecordingCtrlEvent.
 */
class MeetingShareCtrlEvent : public IMeetingShareCtrlEvent {

public:
    MeetingShareCtrlEvent() {};
    ~MeetingShareCtrlEvent() {};

    /**
     * Fires when sharing status changes (begin/end/pause/resume, self/other).
     * @param shareInfo Sharing information.
     */
    void onSharingStatus(ZoomSDKSharingSourceInfo shareInfo) override;

    /**
     * Fires when a share fails to start — the key signal that the bot was not
     * allowed to share (locked, disabled, another active share, etc.).
     */
    void onFailedToStartShare() override;

    void onLockShareStatus(bool bLocked) override {};
    void onShareContentNotification(ZoomSDKSharingSourceInfo shareInfo) override {};
    void onMultiShareSwitchToSingleShareNeedConfirm(IShareSwitchMultiToSingleConfirmHandler* handler_) override {};
    void onShareSettingTypeChangedNotification(ShareSettingType type) override {};
    void onSharedVideoEnded() override {};
    void onVideoFileSharePlayError(ZoomSDKVideoFileSharePlayError error) override {};
    void onOptimizingShareForVideoClipStatusChanged(ZoomSDKSharingSourceInfo shareInfo) override {};
};


#endif //MEETING_SDK_LINUX_SAMPLE_MEETINGSHARECTRLEVENT_H
