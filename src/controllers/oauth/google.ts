/* eslint-disable @typescript-eslint/camelcase */
import express from 'express';
import axios from 'axios';
import { isNil } from 'lodash';
import createError from 'http-errors';

import User from '../../models/User';
import {
  GoogleOauthProfileResponse,
  GoogleSignupResponse,
  GoogleOauthTokenResponse,
} from '../../types';
import {
  setSsoCookie,
  generateAccessToken,
  generateRefreshToken,
  setSsoRefreshCookie,
} from '../../utilities/jwt';
import { createEncUser, createVmtUser } from '../../controllers/localSignup';

import EncUser from '../../models/EncUser';
import VmtUser from '../../models/VmtUser';
import { sendEmailSMTP, sendEmailsToAdmins } from '../../utilities/emails';
import { AppNames } from '../../config/app_urls';

const getUniqueUsername = async (email: String) => {
  let username;
  let user;
  const MAX_TRIES = 10;
  let tries = 0;

  do {
    username = generateUsername(email);
    user = await User.findOne({ username });
    tries++;
  } while (user && tries < MAX_TRIES);

  if (tries >= MAX_TRIES)
    throw new Error('Exceeded maximum attempts to generate a unique username');

  return username;
};

const generateUsername = (email: String) => {
  const emailPrefix = email.split('@')[0];

  const shortPrefix = emailPrefix.substring(0, 5);

  const randomThreeDigitNumber = Math.floor(100 + Math.random() * 900);

  return shortPrefix + randomThreeDigitNumber;
};

export const handleUserProfile = async (
  userProfile: GoogleOauthProfileResponse,
): Promise<GoogleSignupResponse> => {
  let { sub, given_name, family_name, picture, email } = userProfile;

  // check if user exists already with username = to email
  // or if user previously signed up locally with username / password but with same email

  let existingUser = await User.findOne({
    $or: [{ username: email }, { email }],
  });

  if (existingUser === null) {
    let mtUser = await User.create({
      username: await getUniqueUsername(email),
      email,
      googleId: sub,
      firstName: given_name,
      lastName: family_name,
      googleProfilePic: picture,
      isEmailConfirmed: true,
    });

    return {
      mtUser,
      message: null,
    };
  }

  // email already associated with an account
  let { googleId } = existingUser;

  if (typeof googleId !== 'string') {
    // existing user is not from google sign up
    return {
      mtUser: null,
      message: 'Email is already in use',
    };
  }

  return {
    mtUser: existingUser,
    message: null,
  };
};

export const googleCallback = async (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): Promise<void> => {
  let mtUser;
  let didCreateMtUser = false;
  let encUser;
  let vmtUser;

  try {
    let { code } = req.query;
    if (code === undefined) {
      return;
    }

    if (code) {
      // exchange code for access token
      let googleEndpoint = `https://www.googleapis.com/oauth2/v4/token`;
      let params = {
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: process.env.GOOGLE_CALLBACK_URL,
        grant_type: 'authorization_code',
      };

      let results = await axios.post(googleEndpoint, params);

      let resultsData: GoogleOauthTokenResponse = results.data;

      let { access_token } = resultsData;
      let userProfileEndpoint = 'https://www.googleapis.com/oauth2/v3/userinfo';

      let config = {
        headers: { Authorization: 'Bearer ' + access_token },
      };

      let profileResults = await axios.get(userProfileEndpoint, config);

      let profile: GoogleOauthProfileResponse = profileResults.data;

      let mtUserResults = await handleUserProfile(profile);
      mtUser = mtUserResults.mtUser;
      if (mtUser === null) {
        let redirectUrl = req.cookies.failureRedirectUrl;
        let error = 'oauthError=emailUnavailable';

        res.redirect(`${redirectUrl}?${error}`);

        return;
      }
      // What is best way to know if user is signing in with google for the first time?
      // Should never have only one of encUserId / vmtUserId ... but what if one failed for some reason?

      let isNewUser = isNil(mtUser.encUserId);

      if (!isNewUser) {
        // catch if pending user data was not added to existing VMT user
        // Matches for VMT user with same email and 'pending' accountType
        // env toggle to enable feature
        if (
          process.env.VMT_YES_TO_CONVT_PENDING &&
          process.env.VMT_YES_TO_CONVT_PENDING.toLowerCase() === 'yes'
        ) {
          // find VMT user with data
          const vmtPendingData = await VmtUser.findOne({
            email: mtUser.email,
            accountType: 'pending',
          });
          // find duplicate VMT user to remove
          const vmtMTdata = await VmtUser.findOne({
            email: mtUser.email,
            ssoId: mtUser._id,
          });
          if (
            vmtPendingData &&
            vmtPendingData.accountType === 'pending' &&
            vmtMTdata
          ) {
            // Swap linked Ids to link sso account with VMT account with data
            await VmtUser.findByIdAndUpdate(vmtPendingData._id, {
              ssoId: mtUser._id,
              accountType: 'facilitator',
              isEmailConfirmed: true,
            });
            mtUser.vmtUserId = vmtPendingData._id;
            await mtUser.save();

            // invalidate or delete duplicate record
            await VmtUser.findByIdAndUpdate(vmtMTdata._id, {
              isTrashed: true,
              accountType: 'temp',
              email: '',
            });
            // await VmtUser.findByIdAndUpdate(vmtMTdata._id, { ssoId: '' });
            // await VmtUser.findByIdAndDelete(vmtMTdata._id);
          }
        }
      }

      if (isNewUser) {
        // check to see if the email is pre-loaded to VMT with user-data
        const vmtUserData = await VmtUser.findOne({ email: mtUser.email });

        [encUser, vmtUser] = await Promise.all([
          createEncUser(mtUser, {}, 'google'),
          createVmtUser(mtUser, vmtUserData || {}, 'google'),
        ]);

        if (encUser === null || vmtUser === null) {
          if (encUser !== null) {
            // vmt errored but enc was successful
            // revert creating of enc user
            await EncUser.findByIdAndDelete(encUser._id);
          } else if (vmtUser !== null) {
            await VmtUser.findByIdAndDelete(vmtUser._id);
          }
          // both creation processes failed
          // just return error
          return next(
            new createError[500](
              'Sorry, an unexpected error occured. Please try again.',
            ),
          );
        }

        mtUser.encUserId = encUser._id;
        mtUser.vmtUserId = vmtUser._id;

        await mtUser.save();
        didCreateMtUser = true;
      }

      if (mtUser.isSuspended) {
        let redirectUrl = req.cookies.failureRedirectUrl;
        let error = 'oauthError=userSuspended';
        res.redirect(`${redirectUrl}?${error}`);
        return;
      }
      let [accessToken, refreshToken] = await Promise.all([
        generateAccessToken(mtUser),
        generateRefreshToken(mtUser),
      ]);

      setSsoCookie(res, accessToken);
      setSsoRefreshCookie(res, refreshToken);

      let redirectURL = req.cookies.successRedirectUrl;
      let appName;
      let hostUrl;

      if (redirectURL.includes(process.env.ENC_URL)) {
        appName = AppNames.Enc;
        hostUrl = process.env.ENC_URL;
      } else {
        appName = AppNames.Vmt;
        hostUrl = process.env.VMT_URL;
      }

      if (isNewUser) {
        sendEmailSMTP(
          mtUser.email || '',
          hostUrl,
          'googleSignup',
          null,
          mtUser,
          appName,
        );

        if (process.env.NODE_ENV === 'production') {
          sendEmailsToAdmins(hostUrl, appName, 'newUserNotification', mtUser);
        } else {
          sendEmailSMTP(
            process.env.EMAIL_USERNAME,
            hostUrl,
            'newUserNotification',
            null,
            mtUser,
            appName,
          );
        }
      }

      res.redirect(redirectURL);
    }
  } catch (err) {
    if (didCreateMtUser === false) {
      // error creating sso user
      // revert enc / vmt creation if necessary
      if (encUser) {
        EncUser.findByIdAndDelete(encUser._id);
      }
      if (vmtUser) {
        VmtUser.findByIdAndDelete(vmtUser._id);
      }
      return next(
        new createError[500](
          'Sorry, an unexpected error occured. Please try again.',
        ),
      );
    }
    next(err);
  }
};

export const googleOauth = async (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): Promise<void> => {
  try {
    let googleEndpoint = `https://accounts.google.com/o/oauth2/v2/auth`;

    let clientId = process.env.GOOGLE_CLIENT_ID;
    let responseType = 'code';
    let scope = 'profile%20email';
    let redirectURI = process.env.GOOGLE_CALLBACK_URL;
    let includeScopes = true;

    let url = `${googleEndpoint}?client_id=${clientId}&response_type=${responseType}&scope=${scope}&redirect_uri=${redirectURI}&include_granted_scopes=${includeScopes}`;

    let options: express.CookieOptions = {
      httpOnly: true,
      maxAge: 300000, // 5min,
    };

    res.cookie('successRedirectUrl', req.mt.oauth.successRedirectUrl, options);
    res.cookie('failureRedirectUrl', req.mt.oauth.failureRedirectUrl, options);

    res.redirect(url);
  } catch (err) {
    next(err);
  }
};
