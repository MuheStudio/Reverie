$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Devices.Geolocation.Geolocator, Windows.Devices.Geolocation, ContentType = WindowsRuntime]

function ConvertTo-LocationJson {
    param([hashtable]$Value)
    $Value | ConvertTo-Json -Compress -Depth 4
}

function Wait-WinRtOperation {
    param(
        [Parameter(Mandatory = $true)]$Operation,
        [Parameter(Mandatory = $true)][Type]$ResultType,
        [Parameter(Mandatory = $true)][int]$TimeoutMilliseconds
    )
    $method = [System.WindowsRuntimeSystemExtensions].GetMethods() |
        Where-Object {
            $_.Name -eq 'AsTask' -and
            $_.IsGenericMethod -and
            $_.GetParameters().Count -eq 1
        } |
        Select-Object -First 1
    if ($null -eq $method) {
        throw [System.PlatformNotSupportedException]::new('WinRT task adapter is unavailable')
    }
    $task = $method.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
    if (-not $task.Wait($TimeoutMilliseconds)) {
        throw [System.TimeoutException]::new('Windows location request timed out')
    }
    return $task.Result
}

try {
    $access = Wait-WinRtOperation `
        -Operation ([Windows.Devices.Geolocation.Geolocator]::RequestAccessAsync()) `
        -ResultType ([Windows.Devices.Geolocation.GeolocationAccessStatus]) `
        -TimeoutMilliseconds 10000
    $accessName = $access.ToString()
    if ($accessName -ne 'Allowed') {
        ConvertTo-LocationJson @{
            ok = $false
            code = if ($accessName -eq 'Denied') {
                'REVERIE_LOCATION_PERMISSION_DENIED'
            } else {
                'REVERIE_LOCATION_ACCESS_UNSPECIFIED'
            }
            status = $accessName
        }
        exit 0
    }

    $locator = [Windows.Devices.Geolocation.Geolocator]::new()
    $locator.DesiredAccuracy = [Windows.Devices.Geolocation.PositionAccuracy]::Default
    $nativeStatus = $locator.LocationStatus.ToString()
    if ($nativeStatus -eq 'Disabled') {
        ConvertTo-LocationJson @{
            ok = $false
            code = 'REVERIE_LOCATION_SERVICE_DISABLED'
            status = $nativeStatus
        }
        exit 0
    }
    if ($nativeStatus -eq 'NotAvailable') {
        ConvertTo-LocationJson @{
            ok = $false
            code = 'REVERIE_LOCATION_DEVICE_UNAVAILABLE'
            status = $nativeStatus
        }
        exit 0
    }

    $position = Wait-WinRtOperation `
        -Operation ($locator.GetGeopositionAsync(
            [TimeSpan]::FromMinutes(10),
            [TimeSpan]::FromSeconds(10)
        )) `
        -ResultType ([Windows.Devices.Geolocation.Geoposition]) `
        -TimeoutMilliseconds 12000
    $coordinate = $position.Coordinate
    $point = $coordinate.Point.Position
    ConvertTo-LocationJson @{
        ok = $true
        code = 'REVERIE_LOCATION_OK'
        status = $locator.LocationStatus.ToString()
        latitude = $point.Latitude
        longitude = $point.Longitude
        accuracy = $coordinate.Accuracy
        timestamp = $coordinate.Timestamp.ToString('o')
        source = 'windows-winrt'
    }
} catch [System.TimeoutException] {
    ConvertTo-LocationJson @{
        ok = $false
        code = 'REVERIE_LOCATION_TIMEOUT'
        status = 'Timeout'
    }
} catch [System.UnauthorizedAccessException] {
    ConvertTo-LocationJson @{
        ok = $false
        code = 'REVERIE_LOCATION_PERMISSION_DENIED'
        status = 'Denied'
    }
} catch {
    $hresult = $_.Exception.HResult
    $code = if ($hresult -eq -2147024891) {
        'REVERIE_LOCATION_PERMISSION_DENIED'
    } elseif ($hresult -eq -2147023728) {
        'REVERIE_LOCATION_NO_DATA'
    } else {
        'REVERIE_LOCATION_NATIVE_FAILURE'
    }
    ConvertTo-LocationJson @{
        ok = $false
        code = $code
        status = 'Failed'
        hresult = $hresult
    }
}
